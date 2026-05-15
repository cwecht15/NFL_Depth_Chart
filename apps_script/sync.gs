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

// Editor allowlist. Must match the `allowlist` in docs/auth.config.json.
// Set deployment to "Anyone with Google account"; this is the second check.
const EDITOR_ALLOWLIST = [
  "cwecht8@gmail.com",
  "tbmoore2016@gmail.com",
];

// Admins who may call forceReleaseLock to clear someone else's lock without
// waiting for TTL. Empty = nobody (TTL expiry is still automatic).
const LOCK_ADMIN_ALLOWLIST = [
  "cwecht8@gmail.com",
  "tbmoore2016@gmail.com",
];

// === Multi-user locks =====================================================
//
// Two operational tabs persist multi-user state on the same workbook:
//   - LOCKS_TAB:    one row per actively-edited team (FA never locks)
//   - AUDIT_TAB:    append-only log of who changed what (and lock events)
//
// Choosing tabs over PropertiesService is deliberate: tabs are human-
// inspectable, survive script redeploys, and can be hand-edited if a lock
// gets stuck (e.g., during incident response).

const LOCKS_TAB  = "Locks";
const AUDIT_TAB  = "AuditLog";

const LOCKS_HEADERS = ["team", "owner_email", "acquired_at", "last_heartbeat_at"];
const AUDIT_HEADERS = ["ts", "actor_email", "action", "team", "sheet_row", "column", "before", "after", "details"];

// Lock expires after 30 min of no heartbeat. Browser sends heartbeat every
// 2 min; LOCK_TTL_SECONDS is the absolute idle threshold past which a peer
// may force-take.
const LOCK_TTL_SECONDS = 30 * 60;

// Free-agent placeholder; never locked.
const FA_TEAM = "FA";

// OAuth Web Client ID (same as docs/auth.config.json). Used to verify the
// `aud` claim on Google ID tokens passed up from the browser. This is the
// load-bearing identity check for personal Gmail callers: Apps Script's
// Session.getActiveUser().getEmail() returns "" for them when the web app
// is deployed "Execute as: Me", so we fall back to JWT verification.
const EXPECTED_CLIENT_ID = "504863493135-n5jrls1m670m80iif39o253aa3bkttqs.apps.googleusercontent.com";

// === HTTP entry points ====================================================

function doGet(e) {
  // Health-check + lightweight read endpoints. `?action=listLocks` lets the
  // browser poll lock state without paying the full handler cost.
  const action = (e && e.parameter && e.parameter.action || "").toLowerCase();
  if (action === "listlocks") {
    // Auth still required so we don't leak the editor email list publicly.
    const actorEmail = _getCallerEmail(null, e);
    if (!actorEmail) return _json({ ok: false, error: "sign_in_required" }, 401);
    if (EDITOR_ALLOWLIST.length > 0 && !EDITOR_ALLOWLIST.includes(actorEmail)) {
      return _json({ ok: false, error: "not_authorized", email: actorEmail }, 403);
    }
    return _json(handleListLocks());
  }
  if (action === "whoami") {
    // Diagnostic: returns what we think the caller's identity is plus where
    // we got it from. Helpful when "not_authorized" surprises someone.
    return _json(_whoAmI(null, e));
  }
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

    // Verified identity. Tries Session.getActiveUser().getEmail() first;
    // falls back to verifying the Google ID token (`payload.id_token`)
    // through Google's tokeninfo endpoint, which is the only reliable way
    // to identify non-Workspace callers of a personal Apps Script web app.
    // Body fields like `payload.editor` are informational only.
    const actorEmail = _getCallerEmail(payload, e);

    if (!actorEmail) {
      return _json({ ok: false, error: "sign_in_required" }, 401);
    }
    if (EDITOR_ALLOWLIST.length > 0 && !EDITOR_ALLOWLIST.includes(actorEmail)) {
      return _json({ ok: false, error: "not_authorized", email: actorEmail }, 403);
    }

    const action = (payload.action || "sync").toLowerCase();
    let result;
    switch (action) {
      case "snapshot":
        result = handleSnapshot(payload);
        break;
      case "acquirelock":
        result = handleAcquireLock(payload, actorEmail);
        break;
      case "releaselock":
        result = handleReleaseLock(payload, actorEmail);
        break;
      case "heartbeatlock":
        result = handleHeartbeatLock(payload, actorEmail);
        break;
      case "listlocks":
        result = handleListLocks();
        break;
      case "forcereleaselock":
        result = handleForceReleaseLock(payload, actorEmail);
        break;
      default:
        result = handleSync(payload, actorEmail);
    }
    return _json(result);
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

// === Core =================================================================

function handleSync(payload, actorEmail) {
  const targetTab = payload.target_tab || DEFAULT_TARGET_TAB;
  const commit    = !!payload.commit;
  const allowProd = !!payload.allow_prod;
  actorEmail = actorEmail || Session.getActiveUser().getEmail() || "";

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

  // Lock gate: every distinct team touched by either an update or an append
  // (FA excluded) must be locked by the caller. Dry-runs are gated too so
  // users find out before they bother to commit.
  const teamsTouched = _teamsTouchedByDiff(updates, appends, target, rows);
  const lockCheck = _verifyCallerHoldsLocks(ss, actorEmail, teamsTouched);
  if (!lockCheck.ok) {
    return {
      ok: false,
      error: "missing_lock",
      message: "You must hold a lock for every team you're editing.",
      teams_required: teamsTouched,
      teams_missing: lockCheck.missing,
      teams_held_by_others: lockCheck.heldByOthers,
    };
  }

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
  summary.actor_email = actorEmail || null;
  // Backwards compat with earlier client builds that displayed editor_email.
  summary.editor_email = summary.actor_email;

  // Audit-log one row per applied cell change, using the row's team from the
  // payload (the sheet update may not have included team in the diff).
  _writeAuditRows(ss, _buildAuditEntries(updates, appends, rows, actorEmail, targetTab));

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

// === Live snapshot ========================================================
//
// Returns a fresh-from-the-sheet view of the DepthCharts tab in the same
// shape the static snapshot.json uses for its "depth" section. The frontend
// merges this into its in-memory state when the user clicks Refresh.
// Rosters / Options / Transactions are left to the GitHub Action cron;
// they change less often and would slow this endpoint significantly.

function handleSnapshot(payload) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tab = (payload && payload.source_tab) || "DepthCharts";
  const sheet = ss.getSheetByName(tab);
  if (!sheet) throw new Error("Source tab not found: " + tab);

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  // Row 3 = human-readable label; row 4 = cell notes (JSON keys).
  const labelRow = sheet.getRange(3, 1, 1, lastCol).getDisplayValues()[0];
  const headerRow = sheet.getRange(HEADER_NOTE_ROW, 1, 1, lastCol);
  const notes = headerRow.getNotes()[0];

  const keys = [];
  const keyToCol = {};
  const keyToLabel = {};
  for (let i = 0; i < lastCol; i++) {
    const note = (notes[i] || "").trim();
    if (!note) continue;
    if (!(note in keyToCol)) keys.push(note);
    keyToCol[note] = i; // 0-based; later columns overwrite if duplicate
    const label = (labelRow[i] || "").trim();
    if (label) keyToLabel[note] = label;
  }
  // Eliminate duplicates from `keys` while preserving order (the rightmost
  // column wins via keyToCol[]).
  const seen = new Set();
  const dedupKeys = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    dedupKeys.push(k);
  }

  const eliasIdx = keyToCol["eliasId"];
  const numDataRows = Math.max(0, lastRow - (DATA_START_ROW - 1));
  const rows = [];
  if (numDataRows > 0) {
    const data = sheet.getRange(DATA_START_ROW, 1, numDataRows, lastCol).getDisplayValues();
    for (let r = 0; r < data.length; r++) {
      const rowVals = data[r];
      // Required-column filter: skip rows whose eliasId is blank (matches
      // pull_snapshot.py and the publish path's requiredCol semantics).
      if (eliasIdx === undefined || !rowVals[eliasIdx]) continue;
      const rec = { _sheet_row: DATA_START_ROW + r };
      for (const key of dedupKeys) {
        const c = keyToCol[key];
        rec[key] = rowVals[c] || "";
      }
      rows.push(rec);
    }
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    spreadsheet_id: SPREADSHEET_ID,
    source: "apps-script-live",
    source_tab: tab,
    depth: {
      keys: dedupKeys,
      key_to_label: keyToLabel,
      rows: rows,
    },
  };
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

// === Lock handlers ========================================================

function handleAcquireLock(payload, actorEmail) {
  const team = _normalizeTeam(payload.team);
  if (!team) return { ok: false, error: "missing_team" };
  if (team === FA_TEAM) return { ok: false, error: "fa_not_lockable" };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const scriptLock = LockService.getScriptLock();
  if (!scriptLock.tryLock(5000)) {
    return { ok: false, error: "service_busy" };
  }
  try {
    const sheet = _ensureLocksSheet(ss);
    const state = _readLocks(sheet);
    const now = new Date();

    // Caller may not hold a different team simultaneously.
    const mine = state.byOwner[actorEmail];
    if (mine && mine.team !== team) {
      return {
        ok: false,
        error: "already_holding_other",
        held_team: mine.team,
        message: "Release " + mine.team + " before locking another team.",
      };
    }

    const existing = state.byTeam[team];
    let stolenFrom = null;
    if (existing && existing.owner_email !== actorEmail) {
      const idleS = _idleSeconds(existing, now);
      if (idleS < LOCK_TTL_SECONDS) {
        return {
          ok: false,
          error: "locked_by_other",
          owner_email: existing.owner_email,
          acquired_at: existing.acquired_at,
          last_heartbeat_at: existing.last_heartbeat_at,
          ttl_remaining_s: Math.max(0, LOCK_TTL_SECONDS - idleS),
        };
      }
      // Past TTL → steal.
      stolenFrom = existing.owner_email;
      _writeAuditRows(ss, [_auditRow(now, actorEmail, "lock_stolen", team, {
        from: stolenFrom,
        idle_seconds: idleS,
      })]);
    }

    const lock = {
      team: team,
      owner_email: actorEmail,
      acquired_at: now.toISOString(),
      last_heartbeat_at: now.toISOString(),
    };
    _upsertLock(sheet, state, lock);
    _writeAuditRows(ss, [_auditRow(now, actorEmail, stolenFrom ? "lock_acquired_after_steal" : "lock_acquired", team, stolenFrom ? { from: stolenFrom } : null)]);

    return { ok: true, lock: lock, stolen_from: stolenFrom };
  } finally {
    scriptLock.releaseLock();
  }
}

function handleReleaseLock(payload, actorEmail) {
  const team = _normalizeTeam(payload.team);
  if (!team) return { ok: false, error: "missing_team" };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const scriptLock = LockService.getScriptLock();
  if (!scriptLock.tryLock(5000)) {
    return { ok: false, error: "service_busy" };
  }
  try {
    const sheet = _ensureLocksSheet(ss);
    const state = _readLocks(sheet);
    const existing = state.byTeam[team];
    if (!existing) {
      return { ok: true, released: false, note: "no_lock_for_team" };
    }
    if (existing.owner_email !== actorEmail) {
      return { ok: false, error: "not_owner", owner_email: existing.owner_email };
    }
    _removeLockRow(sheet, state, team);
    _writeAuditRows(ss, [_auditRow(new Date(), actorEmail, "lock_released", team, null)]);
    return { ok: true, released: true };
  } finally {
    scriptLock.releaseLock();
  }
}

function handleHeartbeatLock(payload, actorEmail) {
  const team = _normalizeTeam(payload.team);
  if (!team) return { ok: false, error: "missing_team" };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const scriptLock = LockService.getScriptLock();
  if (!scriptLock.tryLock(5000)) {
    return { ok: false, error: "service_busy" };
  }
  try {
    const sheet = _ensureLocksSheet(ss);
    const state = _readLocks(sheet);
    const existing = state.byTeam[team];
    if (!existing) {
      return { ok: false, error: "no_lock", message: "Lock for " + team + " no longer exists." };
    }
    if (existing.owner_email !== actorEmail) {
      return { ok: false, error: "not_owner", owner_email: existing.owner_email };
    }
    const now = new Date();
    existing.last_heartbeat_at = now.toISOString();
    _upsertLock(sheet, state, existing);
    return { ok: true, lock: existing };
  } finally {
    scriptLock.releaseLock();
  }
}

function handleListLocks() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = _ensureLocksSheet(ss);
  const state = _readLocks(sheet);
  const now = new Date();
  const locks = [];
  for (const team of Object.keys(state.byTeam)) {
    const l = state.byTeam[team];
    const idleS = _idleSeconds(l, now);
    locks.push({
      team: l.team,
      owner_email: l.owner_email,
      acquired_at: l.acquired_at,
      last_heartbeat_at: l.last_heartbeat_at,
      idle_seconds: idleS,
      expired: idleS >= LOCK_TTL_SECONDS,
    });
  }
  return { ok: true, locks: locks, ttl_seconds: LOCK_TTL_SECONDS };
}

function handleForceReleaseLock(payload, actorEmail) {
  if (LOCK_ADMIN_ALLOWLIST.length === 0 || LOCK_ADMIN_ALLOWLIST.indexOf(actorEmail) === -1) {
    return { ok: false, error: "not_admin" };
  }
  const team = _normalizeTeam(payload.team);
  if (!team) return { ok: false, error: "missing_team" };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const scriptLock = LockService.getScriptLock();
  if (!scriptLock.tryLock(5000)) {
    return { ok: false, error: "service_busy" };
  }
  try {
    const sheet = _ensureLocksSheet(ss);
    const state = _readLocks(sheet);
    const existing = state.byTeam[team];
    if (!existing) {
      return { ok: true, released: false, note: "no_lock_for_team" };
    }
    _removeLockRow(sheet, state, team);
    _writeAuditRows(ss, [_auditRow(new Date(), actorEmail, "force_release", team, {
      cleared_owner: existing.owner_email,
    })]);
    return { ok: true, released: true, cleared_owner: existing.owner_email };
  } finally {
    scriptLock.releaseLock();
  }
}

// === Lock storage =========================================================

function _ensureLocksSheet(ss) {
  let sheet = ss.getSheetByName(LOCKS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(LOCKS_TAB);
    sheet.getRange(1, 1, 1, LOCKS_HEADERS.length).setValues([LOCKS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _readLocks(sheet) {
  const lastRow = sheet.getLastRow();
  const byTeam = {};
  const byOwner = {};
  const rowsByTeam = {}; // team -> sheet row number for in-place edit
  if (lastRow < 2) return { byTeam, byOwner, rowsByTeam };
  const values = sheet.getRange(2, 1, lastRow - 1, LOCKS_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const team = String(row[0] || "").trim();
    if (!team) continue;
    const rec = {
      team: team,
      owner_email: String(row[1] || "").trim(),
      acquired_at: row[2] ? (row[2] instanceof Date ? row[2].toISOString() : String(row[2])) : "",
      last_heartbeat_at: row[3] ? (row[3] instanceof Date ? row[3].toISOString() : String(row[3])) : "",
    };
    byTeam[team] = rec;
    if (rec.owner_email) byOwner[rec.owner_email] = rec;
    rowsByTeam[team] = i + 2; // header is row 1
  }
  return { byTeam, byOwner, rowsByTeam };
}

function _upsertLock(sheet, state, lock) {
  const row = [lock.team, lock.owner_email, lock.acquired_at, lock.last_heartbeat_at];
  const existingRow = state.rowsByTeam[lock.team];
  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, LOCKS_HEADERS.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function _removeLockRow(sheet, state, team) {
  const r = state.rowsByTeam[team];
  if (r) sheet.deleteRow(r);
}

function _idleSeconds(lock, now) {
  const hb = lock.last_heartbeat_at || lock.acquired_at;
  if (!hb) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(hb);
  if (!t) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

function _normalizeTeam(t) {
  return String(t == null ? "" : t).trim().toUpperCase();
}

function _verifyCallerHoldsLocks(ss, actorEmail, teamsTouched) {
  const teams = (teamsTouched || []).filter(function (t) { return t && t !== FA_TEAM; });
  if (teams.length === 0) return { ok: true, missing: [], heldByOthers: [] };
  const sheet = _ensureLocksSheet(ss);
  const state = _readLocks(sheet);
  const now = new Date();
  const missing = [];
  const heldByOthers = [];
  for (const team of teams) {
    const l = state.byTeam[team];
    if (!l) {
      missing.push(team);
      continue;
    }
    if (l.owner_email !== actorEmail) {
      // Expired lock counts as missing (caller could re-acquire instead).
      if (_idleSeconds(l, now) >= LOCK_TTL_SECONDS) {
        missing.push(team);
      } else {
        heldByOthers.push({ team: team, owner_email: l.owner_email });
      }
    }
  }
  return { ok: missing.length === 0 && heldByOthers.length === 0, missing: missing, heldByOthers: heldByOthers };
}

function _teamsTouchedByDiff(updates, appends, target, payloadRows) {
  // For updates we need to look up the team for each touched sheet_row. The
  // payload's `rows` array is the authoritative team-per-row source.
  const teamByRow = {};
  for (const r of payloadRows || []) {
    const sr = Number(r._sheet_row) || 0;
    if (!sr) continue;
    teamByRow[sr] = _normalizeTeam(r.team);
  }
  const set = {};
  for (const u of updates) {
    const t = teamByRow[u.row];
    if (t) set[t] = true;
  }
  for (const a of appends) {
    const t = _normalizeTeam(a.team);
    if (t) set[t] = true;
  }
  return Object.keys(set);
}

// === Audit log ============================================================

function _ensureAuditSheet(ss) {
  let sheet = ss.getSheetByName(AUDIT_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIT_TAB);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _auditRow(now, actorEmail, action, team, details) {
  return [
    now.toISOString(),
    actorEmail || "",
    action,
    team || "",
    "",     // sheet_row (unused for lock events)
    "",     // column
    "",     // before
    "",     // after
    details ? JSON.stringify(details) : "",
  ];
}

function _buildAuditEntries(updates, appends, payloadRows, actorEmail, targetTab) {
  const now = new Date();
  const ts = now.toISOString();
  const teamByRow = {};
  for (const r of payloadRows || []) {
    const sr = Number(r._sheet_row) || 0;
    if (!sr) continue;
    teamByRow[sr] = _normalizeTeam(r.team);
  }
  const out = [];
  for (const u of updates) {
    out.push([
      ts, actorEmail, "edit", teamByRow[u.row] || "",
      u.row, u.key, u.before, u.after,
      JSON.stringify({ target_tab: targetTab }),
    ]);
  }
  for (const a of appends) {
    out.push([
      ts, actorEmail, "append", _normalizeTeam(a.team),
      "", "displayName", "", String(a.displayName || ""),
      JSON.stringify({ target_tab: targetTab, eliasId: a.eliasId || "", position: a.position || "" }),
    ]);
  }
  return out;
}

function _writeAuditRows(ss, rows) {
  if (!rows || rows.length === 0) return;
  const sheet = _ensureAuditSheet(ss);
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, AUDIT_HEADERS.length).setValues(rows);
}

// === Identity verification ===============================================
//
// Personal Gmail web apps deployed as "Execute as: Me" don't surface the
// caller's email through Session.getActiveUser() (Google privacy quirk).
// So we additionally accept a Google ID token (JWT) in the request and
// verify it against Google's tokeninfo endpoint. That endpoint validates
// the signature and gives back the verified claims; we then check `aud`
// matches our OAuth client and `email_verified` is true.

function _getCallerEmail(payload, requestEvent) {
  const sessionEmail = (function () {
    try { return Session.getActiveUser().getEmail() || ""; }
    catch (e) { return ""; }
  })();
  if (sessionEmail) return sessionEmail.toLowerCase();
  const token = (payload && payload.id_token)
    || (requestEvent && requestEvent.parameter && requestEvent.parameter.id_token)
    || "";
  if (!token) return "";
  const verified = _verifyIdToken(token);
  return verified ? verified.toLowerCase() : "";
}

function _verifyIdToken(idToken) {
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    if (!data || data.error) return null;
    if (data.aud !== EXPECTED_CLIENT_ID) return null;
    // tokeninfo returns email_verified as a string "true" / "false".
    if (data.email_verified !== "true" && data.email_verified !== true) return null;
    return data.email || null;
  } catch (e) {
    return null;
  }
}

/**
 * One-time setup helper. Run this once from the Apps Script editor to grant
 * the script the `UrlFetchApp` (external_request) OAuth scope it needs to
 * verify Google ID tokens via tokeninfo. Without this, web-app POST handlers
 * fall back to `sign_in_required` for personal Gmail callers.
 *
 * How to use:
 *   1. In the Apps Script editor, select `authorizeScopes` from the function
 *      dropdown next to "Debug".
 *   2. Click "Run".
 *   3. Approve the OAuth consent dialog ("Connect to an external service").
 *   4. The Logger output should show something like
 *      `{"aud":"504...","email":null, "error":"Invalid Value"}` — the call
 *      fails because we passed a dummy token, BUT the scope is now granted
 *      for all future legitimate calls from doPost/doGet.
 *   5. No redeploy needed — web-app deployments use the deployer's
 *      already-granted scopes the next time a request comes in.
 */
function authorizeScopes() {
  const resp = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=dummy",
    { muteHttpExceptions: true }
  );
  Logger.log("response code: %s", resp.getResponseCode());
  Logger.log("response body: %s", resp.getContentText().slice(0, 200));
  Logger.log("Scope is now authorized. doPost should resolve identity correctly.");
}

function _whoAmI(payload, requestEvent) {
  const session = (function () {
    try { return Session.getActiveUser().getEmail() || ""; }
    catch (e) { return ""; }
  })();
  const token = (payload && payload.id_token)
    || (requestEvent && requestEvent.parameter && requestEvent.parameter.id_token)
    || "";
  const verified = token ? _verifyIdToken(token) : null;
  return {
    ok: true,
    session_email: session,
    has_id_token: !!token,
    verified_email: verified || null,
    allowlisted: !!(verified && EDITOR_ALLOWLIST.indexOf(verified.toLowerCase()) >= 0)
      || !!(session && EDITOR_ALLOWLIST.indexOf(session.toLowerCase()) >= 0),
  };
}
