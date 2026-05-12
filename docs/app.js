// Depth Chart Editor — static frontend
//
// Loads a pre-rendered snapshot.json (committed to the repo by the
// GitHub Action) and renders an in-browser editor. All edits live in
// localStorage; nothing here writes back to the Google Sheet.

const CATEGORY_LABELS = {
  OFF: "Offense",
  DEF: "Defense",
  ST: "Special Teams",
  IR: "Injured Reserve",
  SUS: "Suspended",
  PS: "Practice Squad",
};

const CATEGORY_ORDER = ["OFF", "DEF", "ST", "IR", "SUS", "PS"];

const MANUAL_KEYS = new Set([
  "eliasId", "gsisId", "jersey", "team", "status", "statusDescription",
  "nflId", "depthPosition", "depthPositionCategory",
  "injury", "injuryReturnTarget", "injuryStatus",
  "isEdge", "freeAgentSigning", "isTradeAcquisition",
  "displayName",
]);

const BOOL_KEYS = new Set(["isEdge", "freeAgentSigning", "isTradeAcquisition"]);

const DISPLAY_COLUMNS = [
  "depthOrder",
  "depthPosition",
  "displayName",
  "team",
  "jersey",
  "eliasId",
  "gsisId",
  "position",
  "status",
  "statusDescription",
  "injury",
  "injuryReturnTarget",
  "injuryStatus",
  "isEdge",
  "freeAgentSigning",
  "isTradeAcquisition",
];

const LS_KEY = "depthchart_edits_v1";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  snapshot: null,         // raw snapshot.json
  rows: [],               // depth rows (cloned from snapshot, edits applied)
  baseline: new Map(),    // sheet_row -> original row (for diff)
  editedRowKeys: new Set(),  // sheet_rows that have been edited
  edits: [],              // chronological edit log
  currentTeam: null,
  currentCategory: null,
  authedEmail: null,
  authConfig: null,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    // 1. Load optional auth config; if present and non-empty, require sign-in.
    state.authConfig = await tryFetchJSON("./auth.config.json");
    if (state.authConfig && state.authConfig.client_id) {
      setupAuthGate();
      // Stay on the auth gate until Google callback signs us in.
      return;
    }
    setBadge("auth-status", "auth: disabled", "muted");
    await launchApp();
  } catch (err) {
    console.error(err);
    showFatalError(err.message || String(err));
  }
})();

async function launchApp() {
  // Load snapshot.json (the GitHub Action commits it).
  const snap = await fetchSnapshot();
  state.snapshot = snap;
  state.rows = snap.depth.rows.map(r => ({ ...r }));
  state.baseline = new Map(snap.depth.rows.map(r => [r._sheet_row, { ...r }]));
  setSnapshotAgeBadge(snap.generated_at);

  // Replay locally-stored edits, if any.
  restoreEditsFromLocalStorage();

  // Render the app shell into <main>.
  renderShell();

  // Populate controls and render the default team.
  populateTeams();
  populateAddPositionDropdown();
  populateRosterSuggestions();

  if (!state.currentTeam) {
    const stored = localStorage.getItem("depthchart_team");
    state.currentTeam = stored && teamList().includes(stored)
      ? stored
      : (teamList().includes("ARZ") ? "ARZ" : teamList()[0]);
  }
  document.getElementById("team-select").value = state.currentTeam;
  document.getElementById("add-row-team").textContent = state.currentTeam;
  renderTeamView();
  updateEditCount();
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function fetchSnapshot() {
  const url = "./data/snapshot.json?cb=" + Date.now();
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to fetch snapshot (${r.status})`);
  return r.json();
}

async function tryFetchJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function setSnapshotAgeBadge(iso) {
  if (!iso) return;
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  const text = mins < 60
    ? `snapshot: ${mins}m ago`
    : `snapshot: ${Math.round(mins / 60)}h ago`;
  const cls = mins > 60 ? "warn" : "muted";
  setBadge("snapshot-age", text, cls);
}

// ---------------------------------------------------------------------------
// Shell rendering
// ---------------------------------------------------------------------------

function renderShell() {
  const tpl = document.getElementById("tpl-app-shell");
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(tpl.content.cloneNode(true));

  document.getElementById("team-select").addEventListener("change", e => {
    state.currentTeam = e.target.value;
    state.currentCategory = null;
    localStorage.setItem("depthchart_team", state.currentTeam);
    document.getElementById("add-row-team").textContent = state.currentTeam;
    renderTeamView();
  });

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    if (state.editedRowKeys.size > 0 && !confirm("Refreshing will keep your in-memory edits. Continue?")) return;
    const snap = await fetchSnapshot();
    state.snapshot = snap;
    // Rebuild baseline; apply edits on top.
    state.rows = snap.depth.rows.map(r => ({ ...r }));
    state.baseline = new Map(snap.depth.rows.map(r => [r._sheet_row, { ...r }]));
    applyEditsToRows();
    setSnapshotAgeBadge(snap.generated_at);
    renderTeamView();
    toast("Snapshot reloaded.");
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("Discard ALL in-memory edits? This cannot be undone.")) return;
    state.edits = [];
    state.editedRowKeys.clear();
    state.rows = state.snapshot.depth.rows.map(r => ({ ...r }));
    persistEdits();
    renderTeamView();
    updateEditCount();
    toast("Edits discarded.");
  });

  document.getElementById("export-csv-btn").addEventListener("click", exportEditedCSV);
  document.getElementById("export-json-btn").addEventListener("click", exportDiffJSON);
  document.getElementById("add-player-btn").addEventListener("click", onAddPlayer);
  document.getElementById("signout-btn").addEventListener("click", signOut);
}

// ---------------------------------------------------------------------------
// Team / category navigation
// ---------------------------------------------------------------------------

function teamList() {
  const teams = new Set();
  for (const r of state.rows) {
    const t = (r.team || "").trim();
    if (t) teams.add(t);
  }
  return [...teams].sort();
}

function populateTeams() {
  const sel = document.getElementById("team-select");
  sel.innerHTML = "";
  for (const t of teamList()) {
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  }
}

function rowsForTeam(team) {
  return state.rows.filter(r => (r.team || "").trim() === team);
}

function categoriesForTeam(team) {
  const cats = new Set();
  for (const r of rowsForTeam(team)) {
    const c = (r.depthPositionCategory || "").trim() || "OFF";
    cats.add(c);
  }
  return CATEGORY_ORDER.filter(c => cats.has(c)).concat(
    [...cats].filter(c => !CATEGORY_ORDER.includes(c))
  );
}

function renderTeamView() {
  const team = state.currentTeam;
  const cats = categoriesForTeam(team);
  if (!state.currentCategory || !cats.includes(state.currentCategory)) {
    state.currentCategory = cats[0] || null;
  }

  // Tabs
  const tabsEl = document.getElementById("category-tabs");
  tabsEl.innerHTML = "";
  for (const c of cats) {
    const count = rowsForTeam(team).filter(r => (r.depthPositionCategory || "OFF") === c).length;
    const tab = document.createElement("button");
    tab.className = "tab" + (c === state.currentCategory ? " is-active" : "");
    tab.innerHTML = `${CATEGORY_LABELS[c] || c}<span class="tab__count">${count}</span>`;
    tab.addEventListener("click", () => {
      state.currentCategory = c;
      renderTeamView();
    });
    tabsEl.appendChild(tab);
  }

  // Content
  const content = document.getElementById("category-content");
  content.innerHTML = "";

  const cat = state.currentCategory;
  if (!cat) {
    content.innerHTML = `<p class="muted">No rows for ${team}.</p>`;
    return;
  }

  const teamRows = rowsForTeam(team).filter(r => (r.depthPositionCategory || "OFF") === cat);
  // Group by `position` (e.g., LWR/SWR/RWR all collapse to WR). Falls back
  // to `depthPosition` for rows where `position` hasn't been filled in.
  const groups = new Map();
  for (const r of teamRows) {
    const k = (r.position || r.depthPosition || "(unset)").trim() || "(unset)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  for (const [pos, rows] of groups) {
    // Within a group, sort by depthPosition first (so LWR rows come before
    // RWR rows before SWR rows), then by depth order within each subrole.
    rows.sort((a, b) => {
      const dpA = (a.depthPosition || "").trim();
      const dpB = (b.depthPosition || "").trim();
      if (dpA !== dpB) return dpA.localeCompare(dpB);
      return num(a.depthOrder) - num(b.depthOrder);
    });
    content.appendChild(renderPositionCard(pos, rows));
  }
}

function renderPositionCard(pos, rows) {
  const card = document.createElement("div");
  card.className = "pos-card";

  const head = document.createElement("div");
  head.className = "pos-card__head";
  head.innerHTML = `<h3>${escapeHTML(pos)}</h3><span class="pos-card__meta">${rows.length} player${rows.length === 1 ? "" : "s"}</span>`;
  card.appendChild(head);

  const tbl = document.createElement("table");
  tbl.className = "tbl";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const c of DISPLAY_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = c;
    th.dataset.col = c;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    tbody.appendChild(renderRow(r));
  }
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  return card;
}

function renderRow(r) {
  const tr = document.createElement("tr");
  if (state.editedRowKeys.has(r._sheet_row)) tr.classList.add("row--edited");
  if (isPlaceholder(r.eliasId)) tr.classList.add("row--placeholder");

  for (const key of DISPLAY_COLUMNS) {
    const td = document.createElement("td");
    td.dataset.col = key;
    if (key === "depthOrder") td.classList.add("col--order");
    if (key === "eliasId" || key === "gsisId" || key === "playerId") td.classList.add("col--id");
    if (key === "displayName") td.classList.add("col--name");

    if (MANUAL_KEYS.has(key)) {
      td.appendChild(renderEditableCell(r, key));
    } else {
      td.classList.add("col--readonly");
      const val = r[key] ?? "";
      td.textContent = val;
      if (key === "depthOrder" && val === "#N/A") td.textContent = "—";
    }

    // Inline placeholder badge after the eliasId column
    if (key === "eliasId" && isPlaceholder(r.eliasId)) {
      const flag = document.createElement("span");
      flag.className = "placeholder-flag";
      flag.textContent = "placeholder";
      td.appendChild(flag);
    }
    tr.appendChild(td);
  }
  return tr;
}

function renderEditableCell(r, key) {
  const val = r[key] ?? "";
  if (BOOL_KEYS.has(key)) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cell-checkbox";
    input.checked = boolish(val);
    input.addEventListener("change", () => recordEdit(r, key, input.checked));
    return input;
  }

  if (key === "depthPositionCategory") {
    return renderSelectCell(r, key, val, CATEGORY_ORDER);
  }
  if (key === "depthPosition") {
    return renderSelectCell(r, key, val, state.snapshot.options.depthPosition || []);
  }
  if (key === "team") {
    return renderSelectCell(r, key, val, teamList());
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cell-input";
  input.value = val;
  input.dataset.key = key;
  input.addEventListener("change", () => recordEdit(r, key, input.value));
  return input;
}

function renderSelectCell(r, key, val, options) {
  const sel = document.createElement("select");
  sel.className = "cell-input";
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "—";
  sel.appendChild(blank);
  const seen = new Set();
  for (const o of options) {
    if (seen.has(o)) continue;
    seen.add(o);
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  }
  if (val && !seen.has(val)) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = val + " (custom)";
    sel.appendChild(opt);
  }
  sel.value = val || "";
  sel.addEventListener("change", () => recordEdit(r, key, sel.value));
  return sel;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function recordEdit(row, key, newValue) {
  const before = row[key];
  const after = BOOL_KEYS.has(key) ? !!newValue : String(newValue);
  if (String(before ?? "") === String(after ?? "")) return;

  row[key] = after;
  state.editedRowKeys.add(row._sheet_row);
  state.edits.push({
    sheet_row: row._sheet_row,
    column: key,
    before: before ?? "",
    after,
    ts: new Date().toISOString(),
    who: state.authedEmail || "anon",
  });
  persistEdits();
  updateEditCount();
  // Visual touch-up without re-rendering the whole grid.
  const trs = document.querySelectorAll(`.tbl tbody tr`);
  for (const tr of trs) {
    // No reliable selector; cheap re-render keeps this simple.
  }
  // Light re-render: only the current view.
  renderTeamView();
}

function persistEdits() {
  try {
    const payload = {
      edits: state.edits,
      ts: new Date().toISOString(),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("localStorage full or unavailable:", err);
  }
}

function restoreEditsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    state.edits = payload.edits || [];
    applyEditsToRows();
  } catch (err) {
    console.warn("Could not parse saved edits:", err);
  }
}

function applyEditsToRows() {
  // Rebuild state.editedRowKeys from logs, applying values to live rows.
  state.editedRowKeys.clear();
  const byRow = new Map(state.rows.map(r => [r._sheet_row, r]));
  for (const e of state.edits) {
    const r = byRow.get(e.sheet_row);
    if (!r) continue;
    r[e.column] = e.after;
    state.editedRowKeys.add(e.sheet_row);
  }
}

function updateEditCount() {
  const n = state.edits.length;
  const el = document.getElementById("edit-count");
  el.textContent = `${n} edit${n === 1 ? "" : "s"}`;
  el.classList.toggle("badge--muted", n === 0);
  el.classList.toggle("badge--accent", n > 0);
}

// ---------------------------------------------------------------------------
// Add player
// ---------------------------------------------------------------------------

function populateAddPositionDropdown() {
  const sel = document.getElementById("add-depth-position");
  sel.innerHTML = "";
  const opts = state.snapshot.options.depthPosition || [];
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "—";
  sel.appendChild(blank);
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  }
}

function populateRosterSuggestions() {
  const list = document.getElementById("roster-suggestions");
  list.innerHTML = "";
  const rosters = state.snapshot.rosters;
  if (!rosters || !rosters.rows) return;
  const nameIdx = rosters.headers.indexOf("displayName");
  if (nameIdx < 0) return;
  // De-dupe.
  const seen = new Set();
  for (const r of rosters.rows) {
    const n = r[nameIdx];
    if (n && !seen.has(n)) { seen.add(n); const o = document.createElement("option"); o.value = n; list.appendChild(o); }
  }
}

function onAddPlayer() {
  const team = state.currentTeam;
  const name = document.getElementById("add-player-search").value.trim();
  const pos = document.getElementById("add-depth-position").value;
  const cat = document.getElementById("add-category").value;
  if (!name) { toast("Pick a player or type a name."); return; }

  // Try to resolve eliasId/gsisId from Rosters.
  const rosters = state.snapshot.rosters;
  const nameIdx = rosters.headers.indexOf("displayName");
  const esbIdx  = rosters.headers.indexOf("esbId");
  const gsisIdx = rosters.headers.indexOf("gsisId");
  let eliasId = "", gsisId = "";
  if (nameIdx >= 0) {
    const match = rosters.rows.find(r => r[nameIdx] === name);
    if (match) {
      eliasId = (esbIdx >= 0 ? match[esbIdx] : "") || "";
      gsisId  = (gsisIdx >= 0 ? match[gsisIdx] : "") || "";
    }
  }

  // Allocate a virtual sheet_row above all existing data.
  const maxRow = Math.max(...state.rows.map(r => Number(r._sheet_row) || 0), 100000);
  const newRow = {
    _sheet_row: maxRow + 1,
    team,
    displayName: name,
    depthPosition: pos,
    depthPositionCategory: cat,
    eliasId,
    gsisId,
    _new: true,
  };
  state.rows.push(newRow);

  // Log each field as an "edit" so the diff/export sees the new row.
  const ts = new Date().toISOString();
  for (const k of ["team", "displayName", "depthPosition", "depthPositionCategory", "eliasId", "gsisId"]) {
    if (newRow[k] === "" || newRow[k] === undefined) continue;
    state.edits.push({ sheet_row: newRow._sheet_row, column: k, before: "", after: newRow[k], ts, who: state.authedEmail || "anon" });
  }
  state.editedRowKeys.add(newRow._sheet_row);
  persistEdits();
  updateEditCount();
  renderTeamView();
  document.getElementById("add-player-search").value = "";
  toast(`Added ${name} to ${team} (in-memory).`);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportEditedCSV() {
  const keys = state.snapshot.depth.keys.slice();
  const labelMap = state.snapshot.depth.key_to_label || {};
  const header = ["_sheet_row", ...keys];
  const rows = state.rows.slice().sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));
  const csv = [
    header.join(","),
    ...rows.map(r => header.map(k => csvCell(r[k])).join(",")),
  ].join("\n");
  download("depthcharts-edited.csv", csv, "text/csv");
}

function exportDiffJSON() {
  const payload = {
    generated_at: new Date().toISOString(),
    snapshot_at: state.snapshot.generated_at,
    editor: state.authedEmail || "anon",
    edits: state.edits,
    edited_row_count: state.editedRowKeys.size,
    edit_count: state.edits.length,
  };
  download("depthcharts-diff.json", JSON.stringify(payload, null, 2), "application/json");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function download(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Auth (Google Identity Services)
// ---------------------------------------------------------------------------

function setupAuthGate() {
  document.getElementById("auth-gate").style.display = "flex";
  setBadge("auth-status", "auth: required", "warn");

  const wait = setInterval(() => {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      clearInterval(wait);
      google.accounts.id.initialize({
        client_id: state.authConfig.client_id,
        callback: onGoogleCredential,
        auto_select: false,
      });
      google.accounts.id.renderButton(
        document.getElementById("google-signin"),
        { theme: "filled_black", size: "large", text: "signin_with" }
      );
    }
  }, 80);
}

async function onGoogleCredential(resp) {
  const email = decodeJwtEmail(resp.credential);
  const allow = (state.authConfig.allowlist || []).map(s => s.toLowerCase());
  if (!email) {
    showAuthError("Could not read email from Google response.");
    return;
  }
  if (allow.length && !allow.includes(email.toLowerCase())) {
    showAuthError(`Sorry, ${email} is not on the editor allowlist.`);
    return;
  }
  state.authedEmail = email;
  document.getElementById("auth-gate").style.display = "none";
  setBadge("auth-status", email, "good");
  document.getElementById("signout-btn").style.display = "inline-flex";
  await launchApp();
}

function decodeJwtEmail(jwt) {
  try {
    const [, payload] = jwt.split(".");
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(decodeURIComponent(escape(atob(b64))));
    return decoded.email;
  } catch {
    return null;
  }
}

function showAuthError(msg) {
  document.getElementById("auth-error").textContent = msg;
}

function signOut() {
  state.authedEmail = null;
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  setBadge("auth-status", "auth: signed out", "warn");
  document.getElementById("signout-btn").style.display = "none";
  document.getElementById("auth-gate").style.display = "flex";
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("badge--muted", "badge--accent", "badge--good", "badge--warn", "badge--danger");
  el.classList.add(`badge--${cls}`);
}

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 999;
}

function boolish(v) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y" || s === "x";
}

function isPlaceholder(eid) {
  if (!eid) return false;
  return String(eid).toUpperCase().startsWith("ROOKIE");
}

function toast(msg) {
  // Lightweight: log + brief edit-count flash.
  console.log("[toast]", msg);
  const el = document.getElementById("edit-count");
  if (!el) return;
  el.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }],
    { duration: 280 }
  );
}

function showFatalError(msg) {
  document.getElementById("app").innerHTML = `
    <div class="loader" style="color: var(--danger);">
      <p><strong>Fatal:</strong> ${escapeHTML(msg)}</p>
      <p class="muted">Check the browser console for details.</p>
    </div>`;
}
