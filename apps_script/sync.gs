/**
 * DepthChart Sync — standalone Apps Script web app
 * ===================================================
 *
 * This is a BRAND NEW, STANDALONE Apps Script. It is NOT bound to the
 * spreadsheet. It is not connected to the existing _app.gs / _handler.gs /
 * _publish.gs etc. — none of those are touched.
 *
 * The script exposes a single POST endpoint that the static web app calls
 * with a sync_export.json payload. It computes a diff against a target tab
 * (default: "Copy of DepthCharts") and writes the changed manual cells,
 * appending any new rows. The live "DepthCharts" tab is gated behind an
 * explicit `allow_prod` flag.
 *
 * SEE apps_script/README.md FOR DEPLOYMENT.
 */

// === Settings =============================================================

const SPREADSHEET_ID    = "1XHXiR__p7h2JVLKNkS-F9aiKZjhar78YubQklW_baQA";
const DEFAULT_TARGET_TAB = "Copy of DepthCharts";
const PROD_TAB          = "DepthCharts";

// Row 4 of the target tab carries cell notes that name the JSON key for
// each column. Row 5 is the first data row.
const HEADER_NOTE_ROW = 4;
const DATA_START_ROW  = 5;

// JSON keys writable from the web app. Anything not in this set (formula
// outputs, IDs derived elsewhere, bookkeeping) is left alone.
const MANUAL_KEYS = new Set([
  "eliasId", "gsisId", "jersey", "team", "status", "statusDescription",
  "nflId", "position", "depthPosition", "depthPositionCategory",
  "injury", "injuryReturnTarget", "injuryStatus",
  "isEdge", "freeAgentSigning", "isTradeAcquisition",
  "displayName", "firstName", "lastName", "footballName",
]);

// Optional editor allowlist. Set deployment to "Anyone with Google account",
// then put approved emails here. Leave empty to allow any signed-in account.
const EDITOR_ALLOWLIST = [
  // "alice@example.com",
];

// === HTTP entry points ====================================================

function doGet(_e) {
  // Health-check. Returns a small JSON so the web app can confirm the URL
  // is wired up correctly without doing a write.
  return _json({
    ok: true,
    service: "DepthChart sync",
    spreadsheet_id: SPREADSHEET_ID,
    default_target_tab: DEFAULT_TARGET_TAB,
    time: new Date().toISOString(),
  });
}

function doPost(e) {
  try {
    // The web app uses Content-Type: text/plain to avoid a CORS preflight,
    // so the body is still raw JSON.
    const payload = JSON.parse(e.postData.contents || "{}");

    if (EDITOR_ALLOWLIST.length > 0) {
      const email = Session.getActiveUser().getEmail();
      if (!email || !EDITOR_ALLOWLIST.includes(email)) {
        return _json({ ok: false, error: "not_authorized", email: email || null }, 403);
      }
    }

    const result = handleSync(payload);
    return _json(result);
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

// === Core =================================================================

function handleSync(payload) {
  const targetTab = payload.target_tab || DEFAULT_TARGET_TAB;
  const commit    = !!payload.commit;
  const allowProd = !!payload.allow_prod;

  if (targetTab === PROD_TAB && !allowProd) {
    throw new Error(
      "Refusing to write to " + PROD_TAB +
      "; resend with allow_prod=true to override."
    );
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(targetTab);
  if (!sheet) {
    throw new Error("Target tab not found: " + targetTab);
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const target = _readTargetTab(sheet);

  const { updates, appends } = _computeDiff(rows, target);

  const summary = {
    ok: true,
    target_tab: targetTab,
    dry_run: !commit,
    updates_count: updates.length,
    appends_count: appends.length,
    sample_updates: updates.slice(0, 12).map((u) => ({
      row: u.row, key: u.key,
      before: u.before, after: u.after,
    })),
    sample_appends: appends.slice(0, 5).map((r) => ({
      displayName: r.displayName || "",
      team:        r.team || "",
      depthPosition: r.depthPosition || "",
      eliasId:     r.eliasId || "",
    })),
  };

  if (!commit) {
    summary.note = "Dry-run — pass commit=true to actually write.";
    return summary;
  }

  const t0 = Date.now();
  const cellsWritten = _applyUpdates(sheet, updates);
  let appendInfo = null;
  if (appends.length > 0) {
    appendInfo = _applyAppends(sheet, appends, target);
  }
  summary.cells_written = cellsWritten;
  if (appendInfo) {
    summary.appended_at_row = appendInfo.startRow;
    summary.appended_rows = appendInfo.numRows;
  }
  summary.elapsed_ms = Date.now() - t0;
  summary.editor_email = Session.getActiveUser().getEmail() || null;
  return summary;
}

// === Helpers ==============================================================

function _readTargetTab(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  // Notes and formulas for row 4 → JSON-key map + formula-column set.
  const headerRange = sheet.getRange(HEADER_NOTE_ROW, 1, 1, lastCol);
  const notes    = headerRange.getNotes()[0];
  const formulas = headerRange.getFormulas()[0];

  const keyToCol = {};
  const formulaCols = new Set(); // 1-based column indices
  for (let i = 0; i < lastCol; i++) {
    const note = (notes[i] || "").trim();
    if (note) keyToCol[note] = i + 1;
    if (formulas[i]) formulaCols.add(i + 1);
  }
  const colToKey = {};
  Object.keys(keyToCol).forEach((k) => { colToKey[keyToCol[k]] = k; });

  // Current data rows (formatted strings so we compare apples-to-apples).
  let current = {}; // sheet_row -> { key: value }
  let highestDataRow = DATA_START_ROW - 1;
  if (lastRow >= DATA_START_ROW) {
    const dataRange = sheet.getRange(
      DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastCol
    );
    const display = dataRange.getDisplayValues();
    for (let r = 0; r < display.length; r++) {
      const sheetRow = DATA_START_ROW + r;
      const rowVals = display[r];
      const rec = {};
      let anyFilled = false;
      for (let c = 0; c < rowVals.length; c++) {
        const key = colToKey[c + 1];
        if (!key) continue;
        const v = (rowVals[c] === null || rowVals[c] === undefined) ? "" : String(rowVals[c]);
        rec[key] = v;
        if (v) anyFilled = true;
      }
      if (anyFilled) {
        current[sheetRow] = rec;
        highestDataRow = sheetRow;
      }
    }
  }

  return {
    keyToCol,
    colToKey,
    formulaCols,
    current,
    lastCol,
    highestDataRow,
  };
}

function _computeDiff(rows, target) {
  const writable = {}; // key → 1-based column
  Object.keys(target.keyToCol).forEach((k) => {
    if (!MANUAL_KEYS.has(k)) return;
    const col = target.keyToCol[k];
    if (target.formulaCols.has(col)) return;
    writable[k] = col;
  });

  const updates = [];
  const appends = [];
  const newRowThreshold = Math.max(target.highestDataRow + 10000, 100000);

  for (const row of rows) {
    const sr = Number(row._sheet_row) || 0;
    const isNew = (sr >= newRowThreshold) || (sr > target.highestDataRow);
    if (isNew) {
      appends.push(row);
      continue;
    }
    const cur = target.current[sr];
    if (!cur) {
      // Row marked existing but not present in target tab — treat as append.
      appends.push(row);
      continue;
    }
    for (const key of Object.keys(writable)) {
      const col = writable[key];
      const desired = _toCellString(row[key]);
      const before  = cur[key] === undefined ? "" : String(cur[key]);
      if (desired === before) continue;
      if (
        ["TRUE","FALSE"].indexOf(desired.toUpperCase()) >= 0 &&
        desired.toUpperCase() === before.toUpperCase()
      ) continue;
      updates.push({ row: sr, col, key, before, after: desired });
    }
  }

  return { updates, appends };
}

function _applyUpdates(sheet, updates) {
  if (updates.length === 0) return 0;
  // Group by row so we make one setValues call per row (cheap-ish even for
  // wide rows, and avoids per-cell HTTP overhead).
  const byRow = {};
  for (const u of updates) {
    if (!byRow[u.row]) byRow[u.row] = [];
    byRow[u.row].push(u);
  }
  let written = 0;
  Object.keys(byRow).forEach((rowStr) => {
    const rowNum = Number(rowStr);
    const cells = byRow[rowStr];
    for (const u of cells) {
      // Per-cell setValue is safe: only the cell we're targeting changes,
      // so neighboring formula cells (and the row-4 ARRAYFORMULA spill) are
      // not disturbed.
      sheet.getRange(rowNum, u.col).setValue(u.after);
      written++;
    }
  });
  return written;
}

function _applyAppends(sheet, appends, target) {
  // Always append BELOW the last data row found in `current` so we don't
  // overwrite anything that might exist below row 5 in the target tab.
  const startRow = target.highestDataRow + 1;
  const numRows  = appends.length;
  if (numRows === 0) return { startRow, numRows };

  // Build a numRows × lastCol matrix. Formula columns get empty strings so
  // the row-4 ARRAYFORMULA spills into them automatically.
  const matrix = [];
  for (const row of appends) {
    const line = new Array(target.lastCol).fill("");
    for (const key of Object.keys(target.keyToCol)) {
      if (!MANUAL_KEYS.has(key)) continue;
      const col = target.keyToCol[key];
      if (target.formulaCols.has(col)) continue;
      line[col - 1] = _toCellString(row[key]);
    }
    matrix.push(line);
  }
  sheet.getRange(startRow, 1, numRows, target.lastCol).setValues(matrix);
  return { startRow, numRows };
}

function _toCellString(v) {
  if (v === null || v === undefined) return "";
  if (v === true)  return "TRUE";
  if (v === false) return "FALSE";
  return String(v);
}

function _json(obj, status) {
  // Apps Script ContentService doesn't expose status codes directly for web
  // apps; we always return 200 and put `ok: false` + an HTTP-ish status in
  // the body for the client to inspect.
  const body = Object.assign({}, obj);
  if (typeof status === "number") body._status = status;
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
