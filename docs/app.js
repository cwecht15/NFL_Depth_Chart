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
  "nflId", "position", "depthPosition", "depthPositionCategory",
  "injury", "injuryReturnTarget", "injuryStatus",
  "isEdge", "freeAgentSigning", "isTradeAcquisition",
  "displayName", "firstName", "lastName", "footballName",
]);

const BOOL_KEYS = new Set(["isEdge", "freeAgentSigning", "isTradeAcquisition"]);

const STATUS_DESCRIPTION_OPTIONS = [
  "Active",
  "Inactive",
  "Inactive/3rd QB",
  "IR",
  "SUS",
  "PUP",
  "PS",
];

const DISPLAY_COLUMNS = [
  "depthOrder",
  "depthPosition",
  "depthPositionCategory",
  "displayName",
  "firstName",
  "lastName",
  "footballName",
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

// LS bases. Keys that are per-user have their owner appended at runtime via
// userScopedKey(); the Apps Script URL + target tab stay machine-scoped because
// they're set once per deploy, not per editor.
const LS_KEY_BASE        = "depthchart_edits_v1";
const LS_DISMISSED_BASE  = "depthchart_dismissed_warnings_v1";
const LS_SYNC_URL        = "depthchart_sync_url_v1";
const LS_TARGET_TAB      = "depthchart_target_tab_v1";
const LS_TEAM_BASE       = "depthchart_team";

const DEFAULT_TARGET_TAB = "DepthCharts";
const LEGACY_TARGET_TAB  = "Copy of DepthCharts";  // migrate away from on load

// Stale-snapshot warning threshold (minutes). Snapshot.json is refreshed every
// ~10 min by the GH Action; flag anything noticeably older than that.
const SNAPSHOT_STALE_MIN = 20;

// Lock control parameters mirror sync.gs.
const LOCK_HEARTBEAT_MS = 2 * 60 * 1000;   // browser → Apps Script
const LOCKS_POLL_MS     = 30 * 1000;       // dropdown refresh cadence
const FA_TEAM           = "FA";

// How recent a transaction must be (in days) to surface as a warning.
// Warnings exist to flag moves the depth chart hasn't caught up to yet;
// anything more than a couple weeks old is either already reconciled or
// no longer actionable noise. The cutoff also guards against the
// Transactions_New fallback dumping months of stale rows.
const TRANSACTION_WARN_DAYS = 14;

// Full team names for the OurLads tracker table, keyed by the sheet's TV
// abbreviations (BLT/CLV/HST/LA — same keys as ourlads.json `teams`).
const OL_TEAM_NAMES = {
  ARZ: "Arizona Cardinals",    ATL: "Atlanta Falcons",      BLT: "Baltimore Ravens",
  BUF: "Buffalo Bills",        CAR: "Carolina Panthers",    CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",   CLV: "Cleveland Browns",     DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",       DET: "Detroit Lions",        GB:  "Green Bay Packers",
  HST: "Houston Texans",       IND: "Indianapolis Colts",   JAX: "Jacksonville Jaguars",
  KC:  "Kansas City Chiefs",   LA:  "Los Angeles Rams",     LAC: "Los Angeles Chargers",
  LV:  "Las Vegas Raiders",    MIA: "Miami Dolphins",       MIN: "Minnesota Vikings",
  NE:  "New England Patriots", NO:  "New Orleans Saints",   NYG: "New York Giants",
  NYJ: "New York Jets",        PHI: "Philadelphia Eagles",  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",     SF:  "San Francisco 49ers",  TB:  "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",     WAS: "Washington Commanders",
};

// Re-fetch the shared OurLads check log when the drawer opens if the last
// fetch is older than this.
const OL_CHECKS_MAX_AGE_MS = 60 * 1000;

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
  warnings: [],
  dismissedWarningIds: new Set(),
  warningFilter: "all",
  ourlads: null,
  transactions: null,    // docs/data/transactions.json (preferred over snapshot.transactions)

  // OurLads update tracker (shared check log lives in the OurladsChecks tab).
  olChecks: {},           // team -> { team, checked_at, checked_by, ourlads_updated_at, ourlads_updated_text }
  olChecksFetchedAt: 0,   // ms timestamp of last successful list fetch
  olChecksError: null,    // last fetch error message, if any
  olFilter: "all",        // all | recheck | checked
  olMarking: new Set(),   // teams with an in-flight "mark checked" request

  // Shared OurLads name aliases (NameAliases tab): normalized OurLads name →
  // { ourlads_name, sheet_name, created_at, created_by }. Applied before the
  // OurLads-vs-chart comparison so known spelling differences stop warning.
  nameAliases: {},

  // Multi-user lock state. An editor can hold locks on several teams at
  // once (sync requires a lock per team touched by pending edits).
  myLocks: [],            // [{ team, owner_email, acquired_at, last_heartbeat_at }, ...]
  allLocks: [],           // last polled list of all locks
  locksFetchedAt: 0,      // ms timestamp
  ttlSeconds: 0,          // server-reported lock TTL (filled by listLocks)

  // Google ID token (JWT) from the GIS callback. Apps Script verifies this
  // via tokeninfo to identify the caller — Session.getActiveUser().getEmail()
  // returns "" for personal Gmail callers of an "Execute as: Me" web app.
  idToken: null,
};

// Per-user localStorage key derivation. Until the user signs in, no per-user
// state should be touched — boot guards this by gating everything behind the
// auth callback.
function userScopedKey(base) {
  const tag = (state.authedEmail || "anon").toLowerCase();
  return base + ":" + tag;
}
function lsKeyEdits()     { return userScopedKey(LS_KEY_BASE); }
function lsKeyDismissed() { return userScopedKey(LS_DISMISSED_BASE); }
function lsKeyTeam()      { return userScopedKey(LS_TEAM_BASE); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    // Auth is mandatory in multi-user mode. auth.config.json must be present
    // with a client_id; otherwise the editor refuses to start. This guarantees
    // every edit is attributable.
    state.authConfig = await tryFetchJSON("./auth.config.json");
    if (!state.authConfig || !state.authConfig.client_id) {
      showFatalError(
        "Sign-in is required. Missing or empty auth.config.json. " +
        "Copy auth.config.json.example to auth.config.json and fill in " +
        "the Google OAuth client_id + editor allowlist."
      );
      return;
    }
    setupAuthGate();
    // Stay on the auth gate until Google callback signs us in.
  } catch (err) {
    console.error(err);
    showFatalError(err.message || String(err));
  }
})();

async function launchApp() {
  // One-time migration: pre-multi-user builds wrote LS without an email
  // suffix. Move that data into the namespaced slot the first time *this*
  // user signs in and the namespaced slot is empty.
  migrateUnNamespacedLS();

  // Load snapshot.json (the GitHub Action commits it).
  const snap = await fetchSnapshot();
  state.snapshot = snap;
  state.rows = snap.depth.rows.map(r => ({ ...r }));
  state.baseline = new Map(snap.depth.rows.map(r => [r._sheet_row, { ...r }]));
  setSnapshotAgeBadge(snap.generated_at);
  maybeShowStaleSnapshotBanner(snap.generated_at);

  // Optional: load OurLads snapshot if the workflow has committed one.
  state.ourlads = await tryFetchJSON("./data/ourlads.json");

  // Prefer the fresh ESPN-sourced transactions file when present; the
  // Transactions_New tab is often months behind.
  state.transactions = await tryFetchJSON("./data/transactions.json");

  // Replay locally-stored edits, if any.
  restoreEditsFromLocalStorage();
  restoreDismissedWarnings();

  // Render the app shell into <main>.
  renderShell();

  // Populate controls and render the default team.
  populateTeams();
  populateAddPositionDropdown();
  populateRosterSuggestions();

  if (!state.currentTeam) {
    const stored = localStorage.getItem(lsKeyTeam());
    state.currentTeam = stored && teamList().includes(stored)
      ? stored
      : (teamList().includes("ARZ") ? "ARZ" : teamList()[0]);
  }
  document.getElementById("team-select").value = state.currentTeam;
  document.getElementById("add-row-team").textContent = state.currentTeam;
  document.getElementById("add-custom-team").textContent = state.currentTeam;
  renderTeamView();
  updateEditCount();

  // Compute and render warnings.
  rebuildWarnings();
  updateOurladsBadge();

  // Multi-user: poll lock state, start a heartbeat for any lock we hold, and
  // warn the user before they leave with unsynced edits.
  await refreshLocks();
  // Shared OurLads check log — not awaited; the badge fills in when it lands.
  refreshOurladsChecks();
  // Shared name aliases — not awaited; warnings recompute when they land.
  refreshNameAliases();
  setInterval(refreshLocks, LOCKS_POLL_MS);
  setInterval(heartbeatTick, LOCK_HEARTBEAT_MS);
  window.addEventListener("beforeunload", onBeforeUnload);

  // Initial state for the team picker: if we previously held a lock for this
  // team in another tab/session, surface it on first paint.
  syncTeamPickerLockUI();
}

function migrateUnNamespacedLS() {
  const pairs = [
    [LS_KEY_BASE, lsKeyEdits()],
    [LS_DISMISSED_BASE, lsKeyDismissed()],
    [LS_TEAM_BASE, lsKeyTeam()],
  ];
  for (const [oldKey, newKey] of pairs) {
    try {
      const legacy = localStorage.getItem(oldKey);
      if (!legacy) continue;
      if (localStorage.getItem(newKey)) continue; // user's slot already populated
      localStorage.setItem(newKey, legacy);
    } catch {}
  }
  // Older builds defaulted Settings → Target tab to "Copy of DepthCharts".
  // The default is now live "DepthCharts"; clear the legacy override so
  // existing browsers don't keep writing to the sandbox tab.
  try {
    if ((localStorage.getItem(LS_TARGET_TAB) || "").trim() === LEGACY_TARGET_TAB) {
      localStorage.removeItem(LS_TARGET_TAB);
    }
  } catch {}
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

function setSnapshotAgeBadge(iso, source) {
  if (!iso) return;
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  const isLive = source === "apps-script-live";
  let text;
  if (isLive && mins < 2) {
    text = "live (just now)";
  } else if (isLive) {
    text = `live (${mins}m ago)`;
  } else if (mins < 60) {
    text = `snapshot: ${mins}m ago`;
  } else {
    text = `snapshot: ${Math.round(mins / 60)}h ago`;
  }
  const cls = isLive ? "good" : (mins > 60 ? "warn" : "muted");
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

  document.getElementById("team-select").addEventListener("change", onTeamSelectChange);
  // Toolbar lock buttons.
  const acquireBtn = document.getElementById("acquire-lock-btn");
  if (acquireBtn) acquireBtn.addEventListener("click", () => acquireCurrentTeamLock());
  const releaseBtn = document.getElementById("release-lock-btn");
  if (releaseBtn) releaseBtn.addEventListener("click", () => releaseCurrentLock());

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    if (state.editedRowKeys.size > 0 && !confirm("Refreshing will keep your in-memory edits. Continue?")) return;
    await refreshSnapshot();
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

  document.getElementById("sync-to-sheet-btn").addEventListener("click", onSyncToSheet);
  document.getElementById("settings-toggle").addEventListener("click", () => openSettings(true));
  document.getElementById("settings-close").addEventListener("click", () => openSettings(false));
  document.getElementById("settings-scrim").addEventListener("click", () => openSettings(false));
  document.getElementById("settings-save").addEventListener("click", onSaveSettings);
  document.getElementById("settings-clear").addEventListener("click", onClearSettings);
  document.getElementById("settings-test").addEventListener("click", onTestSync);
  document.getElementById("settings-export-sync").addEventListener("click", exportSyncJSON);
  document.getElementById("sync-modal-close").addEventListener("click", closeSyncModal);
  document.getElementById("add-player-btn").addEventListener("click", onAddPlayer);
  document.getElementById("add-custom-btn").addEventListener("click", onAddCustomPlayer);
  document.getElementById("signout-btn").addEventListener("click", signOut);

  // Pre-fill the next ROOKIE### slot whenever the user focuses either
  // placeholder field. Defaults both to the same number so the common case
  // (same placeholder across Elias + GSIS) is one click each.
  const fillPlaceholder = (e) => {
    if (e.target.value) return;
    const elias = document.getElementById("add-custom-elias");
    const gsis  = document.getElementById("add-custom-gsis");
    // If the other field already has a ROOKIE### value, reuse that number.
    const otherVal = (e.target.id === "add-custom-elias" ? gsis.value : elias.value).trim();
    if (otherVal && /^ROOKIE\d+$/i.test(otherVal)) {
      e.target.value = otherVal.toUpperCase();
    } else {
      e.target.value = nextPlaceholderId();
    }
  };
  document.getElementById("add-custom-elias").addEventListener("focus", fillPlaceholder);
  document.getElementById("add-custom-gsis").addEventListener("focus", fillPlaceholder);

  // Warnings panel handlers.
  document.getElementById("warnings-toggle").addEventListener("click", () => openWarnings(true));
  document.getElementById("warnings-close").addEventListener("click", () => openWarnings(false));
  document.getElementById("warnings-scrim").addEventListener("click", () => openWarnings(false));
  document.getElementById("warnings-refresh").addEventListener("click", refreshExternalSources);
  document.getElementById("warnings-filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button.chip");
    if (!btn) return;
    state.warningFilter = btn.dataset.filter || "all";
    renderWarnings();
  });

  // OurLads tracker drawer handlers.
  document.getElementById("ourlads-toggle").addEventListener("click", () => openOurladsPanel(true));
  document.getElementById("ourlads-close").addEventListener("click", () => openOurladsPanel(false));
  document.getElementById("ourlads-scrim").addEventListener("click", () => openOurladsPanel(false));
  document.getElementById("ourlads-refresh").addEventListener("click", refreshOurladsTracker);
  document.getElementById("ourlads-filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button.chip");
    if (!btn) return;
    state.olFilter = btn.dataset.filter || "all";
    renderOurladsPanel();
  });
  document.getElementById("ourlads-list").addEventListener("click", (e) => {
    const nav = e.target.closest("button[data-nav]");
    if (nav) { navigateToTeam(nav.dataset.nav); openOurladsPanel(false); return; }
    const mark = e.target.closest("button[data-mark]");
    if (mark && !mark.disabled) markOurladsChecked(mark.dataset.mark);
  });
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
  // Always render the six canonical category tabs in canonical order so
  // navigation is consistent across teams (e.g., Practice Squad has a
  // stable home for every team even when it's currently empty). Any
  // non-standard categories present in the data are appended after.
  const present = new Set();
  for (const r of rowsForTeam(team)) {
    const c = (r.depthPositionCategory || "").trim() || "OFF";
    present.add(c);
  }
  return CATEGORY_ORDER.concat(
    [...present].filter(c => !CATEGORY_ORDER.includes(c))
  );
}

function renderTeamView() {
  const team = state.currentTeam;
  const cats = categoriesForTeam(team);
  if (!state.currentCategory || !cats.includes(state.currentCategory)) {
    state.currentCategory = cats[0] || null;
  }

  // Recompute the duplicate-jersey map for the current team so render-time
  // checks against it are O(1). FA gets included too — duplicates there are
  // less meaningful but flagging them is still strictly informational.
  state.dupJerseysCurrentTeam = _duplicateJerseyMap(team);

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
  if (teamRows.length === 0) {
    const catLabel = CATEGORY_LABELS[cat] || cat;
    content.innerHTML =
      `<p class="muted">No ${escapeHTML(catLabel)} players for ${escapeHTML(team)}.` +
      ` Use the "Add a player" form below to add one, or move a player here by editing their <code>depthPositionCategory</code>.</p>`;
    return;
  }
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

  // Surface duplicate jerseys at the top of the team view — visible even
  // when the conflicting rows live on different category tabs.
  _renderDuplicateJerseyBanner(team, content);
}

function renderPositionCard(pos, rows) {
  const card = document.createElement("div");
  card.className = "pos-card";

  const head = document.createElement("div");
  head.className = "pos-card__head";
  head.innerHTML = `<h3>${escapeHTML(pos)}</h3><span class="pos-card__meta">${rows.length} player${rows.length === 1 ? "" : "s"}</span>`;
  card.appendChild(head);

  // Scroll wrapper so the table can extend wider than the card and the
  // user can swipe / scroll horizontally through all columns.
  const wrap = document.createElement("div");
  wrap.className = "tbl-wrap";

  const tbl = document.createElement("table");
  tbl.className = "tbl";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const thDrag = document.createElement("th");
  thDrag.className = "col--drag";
  thDrag.dataset.col = "_drag";
  thDrag.title = "Drag to reorder within the same depthPosition";
  trh.appendChild(thDrag);
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
  wrap.appendChild(tbl);
  card.appendChild(wrap);
  return card;
}

function renderRow(r) {
  const tr = document.createElement("tr");
  tr.dataset.sheetRow = String(r._sheet_row);
  tr.dataset.depthPosition = (r.depthPosition || "").trim();
  tr.dataset.depthPositionCategory = (r.depthPositionCategory || "").trim();
  tr.dataset.team = (r.team || "").trim();
  if (state.editedRowKeys.has(r._sheet_row)) tr.classList.add("row--edited");
  if (isPlaceholder(r.eliasId)) tr.classList.add("row--placeholder");

  // Drag handle (leading column). Only the grip is draggable, so clicking
  // inputs/selects elsewhere in the row still focuses them normally.
  const dragTd = document.createElement("td");
  dragTd.className = "col--drag";
  dragTd.dataset.col = "_drag";
  const grip = document.createElement("span");
  grip.className = "drag-grip";
  grip.textContent = "⋮⋮";
  const editable = canEditRow(r);
  grip.draggable = editable;
  grip.title = editable
    ? `Drag to reorder ${r.displayName || "this player"} within ${r.depthPosition || "this position"}`
    : lockGateMessage(r);
  if (!editable) grip.classList.add("drag-grip--locked");
  grip.addEventListener("dragstart", onGripDragStart);
  grip.addEventListener("dragend", onGripDragEnd);
  dragTd.appendChild(grip);
  tr.appendChild(dragTd);

  // Drop targets live on the row itself — the grip is just the source.
  tr.addEventListener("dragover", onRowDragOver);
  tr.addEventListener("dragleave", onRowDragLeave);
  tr.addEventListener("drop", onRowDrop);

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
  if (key === "position") {
    return renderSelectCell(r, key, val, state.snapshot.options.position || []);
  }
  if (key === "team") {
    return renderSelectCell(r, key, val, teamList());
  }
  if (key === "statusDescription") {
    return renderSelectCell(r, key, val, STATUS_DESCRIPTION_OPTIONS);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cell-input";
  input.value = val;
  input.dataset.key = key;
  if (key === "jersey") {
    _annotateJerseyDuplicate(input, r, val);
  }
  input.addEventListener("change", () => recordEdit(r, key, input.value));
  return input;
}

// --- Duplicate jersey detection -------------------------------------------
//
// Two rows on the same team with the same non-empty jersey number is almost
// always a mistake (one player got the number, the other still has the old
// value). We surface it as a soft warning — the input gets a red border +
// tooltip, and a banner at the top of the team view lists every dup so the
// user notices even when the conflicting rows live on different category
// tabs. FA ("free agent") is treated like any other team for the scan; the
// noise there is low because we only flag duplicates within the same `team`
// string.
//
// One wrinkle: a single player can legitimately appear on multiple depth-chart
// rows (e.g. Marvin Mims at RWR + PR + KR) all sharing the same jersey. Those
// aren't conflicts, so we collapse rows to one entry per *player* (gsisId →
// eliasId → normalized name) before counting.

function _playerKey(r) {
  const g = (r.gsisId || "").trim();
  if (g) return "g:" + g;
  const e = (r.eliasId || "").trim();
  if (e) return "e:" + e;
  const n = _normalizeName(r.displayName);
  if (n) return "n:" + n;
  return "row:" + r._sheet_row;
}

function _duplicateJerseyMap(team) {
  const map = new Map();
  if (!team) return map;
  for (const r of state.rows) {
    if ((r.team || "").trim() !== team) continue;
    const j = (r.jersey || "").trim();
    if (!j) continue;
    if (!map.has(j)) map.set(j, []);
    map.get(j).push(r);
  }
  // Strip singletons and same-player multi-position rows — only conflicts
  // between *different* players matter.
  for (const [k, v] of map) {
    const distinct = new Set(v.map(_playerKey));
    if (distinct.size < 2) map.delete(k);
  }
  return map;
}

// Pick one representative row per player from a duplicate-jersey group, so
// the banner/tooltip lists each player once even when they hold multiple
// depth-chart slots.
function _distinctPlayerRows(group) {
  const seen = new Set();
  const out = [];
  for (const r of group) {
    const k = _playerKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function _annotateJerseyDuplicate(input, r, val) {
  const dupMap = state.dupJerseysCurrentTeam;
  if (!dupMap) return;
  const j = String(val ?? "").trim();
  if (!j) return;
  const group = dupMap.get(j);
  if (!group || group.length < 2) return;
  const myKey = _playerKey(r);
  const others = _distinctPlayerRows(group)
    .filter(o => _playerKey(o) !== myKey)
    .map(o => `${o.displayName || "(unnamed)"}${o.depthPosition ? ` (${o.depthPosition})` : ""}`);
  if (others.length === 0) return;
  input.classList.add("cell-input--dup");
  input.title =
    `Duplicate jersey #${j} on ${r.team}: also assigned to ${others.join(", ")}.\n` +
    `Heads-up only — this won't block sync, but two players sharing a number is usually a leftover edit.`;
}

function _renderDuplicateJerseyBanner(team, container) {
  const dupMap = state.dupJerseysCurrentTeam;
  if (!dupMap || dupMap.size === 0) return;
  const banner = document.createElement("div");
  banner.className = "dup-jersey-banner";
  const distinctGroups = Array.from(dupMap.entries())
    .map(([j, g]) => [j, _distinctPlayerRows(g)]);
  const total = distinctGroups.reduce((acc, [, g]) => acc + g.length, 0);
  const summary = document.createElement("div");
  summary.className = "dup-jersey-banner__summary";
  summary.innerHTML =
    `<strong>${dupMap.size}</strong> duplicate jersey number${dupMap.size === 1 ? "" : "s"} on ${escapeHTML(team)} ` +
    `(<strong>${total}</strong> player${total === 1 ? "" : "s"} affected).`;
  banner.appendChild(summary);
  const list = document.createElement("ul");
  list.className = "dup-jersey-banner__list";
  for (const [jersey, group] of distinctGroups) {
    const li = document.createElement("li");
    const names = group
      .map(r => `${r.displayName || "(unnamed)"}${r.depthPosition ? ` <span class="muted">${escapeHTML(r.depthPosition)}</span>` : ""}`)
      .join(" · ");
    li.innerHTML = `<span class="dup-jersey-banner__num">#${escapeHTML(jersey)}</span> ${names}`;
    list.appendChild(li);
  }
  banner.appendChild(list);
  container.insertBefore(banner, container.firstChild);
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
// Drag-to-reorder within a depthPosition
// ---------------------------------------------------------------------------
//
// depthOrder is a sheet-side COUNTIFS that ranks rows within depthPosition by
// their physical sheet-row position. To "reorder" we don't write depthOrder
// (it's read-only) — we permute the manual-key payload between the slots in
// sheet-row order so the next COUNTIFS pass produces the user's new ranking.

let _dragSourceSheetRow = null;

function onGripDragStart(ev) {
  const grip = ev.currentTarget;
  const tr = grip.closest("tr");
  if (!tr || !grip.draggable) { ev.preventDefault(); return; }
  _dragSourceSheetRow = Number(tr.dataset.sheetRow);
  tr.classList.add("is-dragging");
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    try { ev.dataTransfer.setData("text/plain", String(_dragSourceSheetRow)); } catch (e) {}
    // Use the row as the drag image for clearer affordance.
    try { ev.dataTransfer.setDragImage(tr, 12, 12); } catch (e) {}
  }
}

function onGripDragEnd(ev) {
  const tr = ev.currentTarget.closest("tr");
  if (tr) tr.classList.remove("is-dragging");
  document.querySelectorAll(".tbl tr.drop-above, .tbl tr.drop-below").forEach((el) => {
    el.classList.remove("drop-above", "drop-below");
  });
  _dragSourceSheetRow = null;
}

function _dragSourceTr(targetTr) {
  // Only valid as a drop target if the source is in the same tbody AND has
  // the same depthPosition. Cross-position drags are rejected.
  if (_dragSourceSheetRow == null) return null;
  const tbody = targetTr.parentElement;
  if (!tbody) return null;
  const src = tbody.querySelector(`tr[data-sheet-row="${_dragSourceSheetRow}"]`);
  if (!src) return null;
  if (src === targetTr) return null;
  if (src.dataset.depthPosition !== targetTr.dataset.depthPosition) return null;
  return src;
}

function onRowDragOver(ev) {
  const tr = ev.currentTarget;
  if (!_dragSourceTr(tr)) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  const rect = tr.getBoundingClientRect();
  const above = ev.clientY < rect.top + rect.height / 2;
  tr.classList.toggle("drop-above", above);
  tr.classList.toggle("drop-below", !above);
}

function onRowDragLeave(ev) {
  ev.currentTarget.classList.remove("drop-above", "drop-below");
}

function onRowDrop(ev) {
  const tr = ev.currentTarget;
  const src = _dragSourceTr(tr);
  if (!src) return;
  ev.preventDefault();
  tr.classList.remove("drop-above", "drop-below");
  const rect = tr.getBoundingClientRect();
  const placeAbove = ev.clientY < rect.top + rect.height / 2;
  performReorder(_dragSourceSheetRow, Number(tr.dataset.sheetRow), placeAbove);
}

function _manualFieldSnapshot(row) {
  const out = {};
  if (!row) return out;
  for (const k of MANUAL_KEYS) out[k] = row[k] ?? "";
  return out;
}

function performReorder(sourceSheetRow, targetSheetRow, placeAbove) {
  const byKey = new Map(state.rows.map((r) => [r._sheet_row, r]));
  const src = byKey.get(sourceSheetRow);
  const tgt = byKey.get(targetSheetRow);
  if (!src || !tgt) return;
  if (!canEditRow(src) || !canEditRow(tgt)) {
    toast(lockGateMessage(src), 4000);
    renderTeamView();
    return;
  }
  const team = (src.team || "").trim();
  const dp   = (src.depthPosition || "").trim();
  const cat  = (src.depthPositionCategory || "").trim();
  // Slots = rows sharing this team / depthPositionCategory / depthPosition,
  // in ascending sheet-row order (== the COUNTIFS rank input order).
  const slotRows = state.rows
    .filter((r) =>
      (r.team || "").trim() === team &&
      (r.depthPosition || "").trim() === dp &&
      (r.depthPositionCategory || "").trim() === cat
    )
    .sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));
  if (slotRows.length < 2) return;
  const slotSheetRows = slotRows.map((r) => Number(r._sheet_row));

  // Compute the new occupant order: take current order, pull source out,
  // reinsert above-or-below the drop target.
  const withoutSrc = slotSheetRows.filter((sr) => sr !== sourceSheetRow);
  const tIdx = withoutSrc.indexOf(targetSheetRow);
  if (tIdx < 0) return;
  const insertAt = placeAbove ? tIdx : tIdx + 1;
  const newOccupantOrder = withoutSrc.slice();
  newOccupantOrder.splice(insertAt, 0, sourceSheetRow);
  if (newOccupantOrder.length !== slotSheetRows.length) return;

  // No-op?
  let unchanged = true;
  for (let i = 0; i < slotSheetRows.length; i++) {
    if (newOccupantOrder[i] !== slotSheetRows[i]) { unchanged = false; break; }
  }
  if (unchanged) return;

  // Snapshot each occupant's manual fields BEFORE we start mutating slots.
  const occupantSnapshots = newOccupantOrder.map((sr) => _manualFieldSnapshot(byKey.get(sr)));

  const now = new Date().toISOString();
  let cellsChanged = 0;
  for (let i = 0; i < slotSheetRows.length; i++) {
    const slotRow = byKey.get(slotSheetRows[i]);
    const desired = occupantSnapshots[i];
    for (const k of MANUAL_KEYS) {
      const before = slotRow[k] ?? "";
      const after  = desired[k] ?? "";
      if (String(before) === String(after)) continue;
      slotRow[k] = after;
      state.editedRowKeys.add(slotRow._sheet_row);
      state.edits.push({
        sheet_row: slotRow._sheet_row,
        column: k,
        before: before,
        after: after,
        ts: now,
        who: state.authedEmail || "anon",
        ident: editIdentity(slotRow),
      });
      cellsChanged++;
    }
  }

  if (cellsChanged === 0) return;

  // Update depthOrder browser-side for immediate visual feedback. Not logged
  // as an edit — depthOrder is a formula column and is excluded from sync.
  for (let i = 0; i < slotSheetRows.length; i++) {
    const slotRow = byKey.get(slotSheetRows[i]);
    slotRow.depthOrder = String(i + 1);
  }

  persistEdits();
  updateEditCount();
  renderTeamView();
  rebuildWarnings();
  toast(`Reordered ${dp || "depth chart"} (${cellsChanged} cell${cellsChanged === 1 ? "" : "s"} changed).`, 3000);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function recordEdit(row, key, newValue) {
  if (!canEditRow(row)) {
    toast(lockGateMessage(row), 4000);
    // Re-render so the input snaps back to its current value visually.
    renderTeamView();
    return;
  }
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
    ident: editIdentity(row),
  });

  // Moving a player off FA: every FA row in the snapshot has
  // depthPositionCategory="PS", so without a follow-up edit the player
  // would land on the new team's Practice Squad tab. Offer to bump them
  // up to the active-roster category that fits their position.
  if (key === "team" && (before || "").toUpperCase() === FA_TEAM && (after || "").toUpperCase() !== FA_TEAM && after) {
    maybePromptCategoryUpgrade(row);
  }

  persistEdits();
  updateEditCount();
  // Cheap re-render of the current team view.
  renderTeamView();
  // Recompute warnings since edits may now resolve some.
  rebuildWarnings();
}

function maybePromptCategoryUpgrade(row) {
  const currentCat = (row.depthPositionCategory || "").trim().toUpperCase();
  if (currentCat && currentCat !== "PS") return;  // only auto-suggest for PS/blank
  const suggested = suggestCategoryFromPosition(row.position || row.depthPosition);
  if (!suggested || suggested === currentCat) return;
  const fromLabel = CATEGORY_LABELS[currentCat] || currentCat || "Practice Squad";
  const toLabel = CATEGORY_LABELS[suggested] || suggested;
  const ok = confirm(
    `Move "${row.displayName || "this player"}" from ${fromLabel} to ${toLabel}?\n\n` +
    `OK   → set depthPositionCategory to ${suggested}\n` +
    `Cancel → keep on Practice Squad`
  );
  if (!ok) return;
  const beforeCat = row.depthPositionCategory ?? "";
  row.depthPositionCategory = suggested;
  state.edits.push({
    sheet_row: row._sheet_row,
    column: "depthPositionCategory",
    before: beforeCat,
    after: suggested,
    ts: new Date().toISOString(),
    who: state.authedEmail || "anon",
    ident: editIdentity(row),
  });
}

function suggestCategoryFromPosition(pos) {
  const p = String(pos || "").trim().toUpperCase();
  if (!p) return null;
  // Offense — skill positions and offensive line.
  if (["QB","RB","FB","HB","WR","LWR","SWR","RWR","TE","OL","OT","OG","C","LT","RT","LG","RG"].indexOf(p) >= 0) return "OFF";
  // Defense — secondary, linebackers, and defensive line / edge.
  if (["CB","S","FS","SS","DB","NB","LB","ILB","OLB","MLB","WLB","SLB","DL","DT","DE","NT","EDGE"].indexOf(p) >= 0) return "DEF";
  // Special teams — kickers, punters, long-snappers, and returners.
  if (["K","P","LS","KR","PR","ST"].indexOf(p) >= 0) return "ST";
  return null;
}

// Lock-aware row gate. FA is intentionally unlocked: it's the league-wide
// bucket of unsigned players, treated like a scratchpad rather than a team.
// Without an Apps Script URL configured we can't audit-log or enforce locks,
// so all edits (including FA) are blocked until Settings is filled in.
function canEditRow(row) {
  if (!getSyncUrl()) return false;
  const t = (row && row.team || "").trim().toUpperCase();
  if (!t || t === FA_TEAM) return true;
  return holdsLock(t);
}
function lockGateMessage(row) {
  if (!getSyncUrl()) return "Open Settings (⚙) and paste the Apps Script URL before editing.";
  const t = (row && row.team || "").trim().toUpperCase() || "this team";
  return "Click \"Lock " + t + "\" to start editing.";
}

function persistEdits() {
  try {
    const payload = {
      edits: state.edits,
      ts: new Date().toISOString(),
    };
    localStorage.setItem(lsKeyEdits(), JSON.stringify(payload));
  } catch (err) {
    console.warn("localStorage full or unavailable:", err);
  }
}

function restoreEditsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(lsKeyEdits());
    if (!raw) return;
    const payload = JSON.parse(raw);
    state.edits = payload.edits || [];
    applyEditsToRows();
  } catch (err) {
    console.warn("Could not parse saved edits:", err);
  }
}

// Identity of the player a row held when it was loaded (the baseline), so an
// edit log entry can later be checked against whatever row now sits at that
// sheet row number. Rows are keyed by row number, and row numbers move when
// someone inserts/deletes rows in the sheet — without this, a persisted edit
// replayed after such a shift would silently land on a different player.
function editIdentity(row) {
  const base = state.baseline.get(row._sheet_row) || row;
  return {
    gsisId: String(base.gsisId ?? "").trim(),
    displayName: String(base.displayName ?? "").trim(),
  };
}

function identityMatchesRow(ident, row) {
  if (!ident) return true;                     // pre-identity edit log entry
  const gsis = String(row.gsisId ?? "").trim();
  const name = String(row.displayName ?? "").trim();
  if (ident.gsisId && gsis) return ident.gsisId === gsis;
  if (ident.displayName && name) return ident.displayName.toLowerCase() === name.toLowerCase();
  return true;                                  // nothing comparable
}

function isVirtualSheetRow(sr) {
  return Number(sr) >= 100000;
}

function applyEditsToRows() {
  // Rebuild state.editedRowKeys from logs, applying values to live rows.
  //
  // Two guards:
  //  * Rows the browser added itself (virtual ids >= 100000) don't exist in a
  //    freshly loaded snapshot — rebuild them from their edit log so a refresh
  //    or reload doesn't silently drop a newly added player.
  //  * An edit whose identity no longer matches the row at that sheet row
  //    number (the sheet was re-rowed underneath us) is discarded and reported
  //    rather than applied to the wrong player.
  state.editedRowKeys.clear();
  const byRow = new Map(state.rows.map(r => [r._sheet_row, r]));
  const keys = (state.snapshot && state.snapshot.depth && state.snapshot.depth.keys) || [];
  const stale = [];
  const kept = [];
  for (const e of state.edits) {
    let r = byRow.get(e.sheet_row);
    if (!r && isVirtualSheetRow(e.sheet_row)) {
      r = { _sheet_row: e.sheet_row, _new: true };
      for (const k of keys) r[k] = "";
      state.rows.push(r);
      byRow.set(e.sheet_row, r);
    }
    if (!r || !identityMatchesRow(e.ident, r)) {
      stale.push(e);
      continue;
    }
    r[e.column] = e.after;
    state.editedRowKeys.add(e.sheet_row);
    kept.push(e);
  }
  if (stale.length > 0) {
    state.edits = kept;
    persistEdits();
    updateEditCount();
    const who = [...new Set(stale.map(e => (e.ident && e.ident.displayName) || ("row " + e.sheet_row)))];
    console.warn("Discarded stale edits (sheet rows moved):", stale);
    toast(
      `${stale.length} pending edit${stale.length === 1 ? "" : "s"} discarded — the sheet's rows moved ` +
      `since they were made (${who.slice(0, 4).join(", ")}${who.length > 4 ? ", …" : ""}). Please redo them.`,
      12000
    );
  }
}

function updateEditCount() {
  const n = state.edits.length;
  const el = document.getElementById("edit-count");
  el.textContent = `${n} edit${n === 1 ? "" : "s"}`;
  el.classList.toggle("badge--muted", n === 0);
  el.classList.toggle("badge--accent", n > 0);
  // Reflect the same state on the Sync button so the user can see at a
  // glance whether there's anything to send.
  const syncBtn = document.getElementById("sync-to-sheet-btn");
  if (syncBtn) {
    syncBtn.disabled = (n === 0);
    syncBtn.title = (n === 0)
      ? "No pending edits to sync."
      : "Send edits to the configured Apps Script web app";
  }
}

// ---------------------------------------------------------------------------
// Multi-user locks (browser side)
// ---------------------------------------------------------------------------

function holdsLock(team) {
  return (state.myLocks || []).some((l) => l.team === team);
}

function heldTeams() {
  return (state.myLocks || []).map((l) => l.team);
}

function canEditTeam(team) {
  if (!getSyncUrl()) return false;
  const t = (team || "").trim().toUpperCase();
  if (!t || t === FA_TEAM) return true;
  return holdsLock(t);
}

async function refreshLocks() {
  const url = getSyncUrl();
  if (!url) return;  // Settings not configured yet; nothing to do.
  try {
    const qs = "?action=listLocks&id_token=" + encodeURIComponent(state.idToken || "");
    const resp = await fetch(url + qs, { redirect: "follow" });
    if (!resp.ok) return;
    const body = await resp.json();
    if (!body || !body.ok) return;
    state.allLocks = body.locks || [];
    state.locksFetchedAt = Date.now();
    if (typeof body.ttl_seconds === "number") state.ttlSeconds = body.ttl_seconds;

    // Reconcile myLocks from server truth — another tab may have released one.
    state.myLocks = state.allLocks
      .filter((l) => l.owner_email === state.authedEmail && !l.expired)
      .map((l) => ({ ...l }));

    syncTeamPickerLockUI();
    renderLocksPanel();
  } catch (err) {
    console.warn("refreshLocks failed:", err);
  }
}

async function heartbeatTick() {
  if (state.myLocks.length === 0) return;
  const url = getSyncUrl();
  if (!url) return;
  try {
    const resp = await _postToSync({ action: "heartbeatLock", teams: heldTeams() });
    if (resp && resp.ok) {
      state.myLocks = (resp.locks || (resp.lock ? [resp.lock] : [])).map((l) => ({ ...l }));
      const lost = resp.lost || [];
      if (lost.length > 0) {
        toast("Your lock on " + lost.join(", ") + " was released by another editor.", 6000);
        syncTeamPickerLockUI();
      }
    } else if (resp && resp.error === "no_lock") {
      // Every lock we thought we held is gone (force-released or stolen).
      const stolen = heldTeams().join(", ");
      state.myLocks = [];
      toast("Your lock on " + stolen + " was released by another editor.", 6000);
      syncTeamPickerLockUI();
    }
  } catch (err) {
    console.warn("heartbeat failed:", err);
  }
}

async function acquireLock(team) {
  const url = getSyncUrl();
  if (!url) {
    toast("Sync URL not set. Open Settings (⚙) and configure it before editing.", 5000);
    return null;
  }
  toast(`Locking ${team}…`, Infinity);
  try {
    const resp = await _postToSync({ action: "acquireLock", team });
    if (resp && resp.ok && resp.lock) {
      const lock = { ...resp.lock };
      state.myLocks = state.myLocks.filter((l) => l.team !== team);
      state.myLocks.push(lock);
      // Optimistic UI update: reflect the new lock immediately instead of
      // waiting for the next listLocks poll. The poll will reconcile any
      // drift within 30 s, but the user shouldn't see a stale toolbar.
      state.allLocks = state.allLocks.filter((l) => l.team !== team);
      state.allLocks.push({
        team: lock.team,
        owner_email: lock.owner_email,
        acquired_at: lock.acquired_at,
        last_heartbeat_at: lock.last_heartbeat_at,
        idle_seconds: 0,
        expired: false,
      });
      syncTeamPickerLockUI();
      renderLocksPanel();
      renderTeamView();
      if (resp.stolen_from) {
        toast(`Took lock on ${team} (previous owner ${resp.stolen_from} was idle).`, 5000);
      } else {
        toast(`Lock acquired: ${team}.`, 3000);
      }
      // Background reconciliation; don't await.
      refreshLocks().catch(() => {});
      return lock;
    }
    if (resp && resp.error === "locked_by_other") {
      toast(`${team} is locked by ${resp.owner_email}.`, 5000);
    } else if (resp && resp.error === "fa_not_lockable") {
      hideToast();
      return null;
    } else {
      toast("Could not acquire lock: " + (resp && resp.error || "unknown"), 5000);
    }
    return null;
  } catch (err) {
    toast("Lock acquire failed: " + (err.message || err), 5000);
    return null;
  }
}

async function releaseLock(team) {
  const url = getSyncUrl();
  if (!url) return false;
  try {
    const resp = await _postToSync({ action: "releaseLock", team });
    if (resp && resp.ok) {
      // Optimistic UI update — flip the toolbar/panel immediately so the
      // user doesn't see a stale "🔓 X" badge for a few seconds while the
      // next poll runs.
      state.myLocks = state.myLocks.filter((l) => l.team !== team);
      state.allLocks = state.allLocks.filter((l) => l.team !== team);
      syncTeamPickerLockUI();
      renderLocksPanel();
      renderTeamView();
      toast(`Released lock on ${team}.`, 3000);
      refreshLocks().catch(() => {});
      return true;
    }
    toast("Release failed: " + (resp && resp.error || "unknown"), 5000);
    return false;
  } catch (err) {
    toast("Release failed: " + (err.message || err), 5000);
    return false;
  }
}

async function releaseAllLocks() {
  const teams = heldTeams();
  if (teams.length === 0) return true;
  try {
    const resp = await _postToSync({ action: "releaseLock", all: true });
    if (resp && resp.ok) {
      state.myLocks = [];
      state.allLocks = state.allLocks.filter((l) => !teams.includes(l.team));
      syncTeamPickerLockUI();
      renderLocksPanel();
      renderTeamView();
      toast(`Released lock${teams.length === 1 ? "" : "s"} on ${teams.join(", ")}.`, 3000);
      refreshLocks().catch(() => {});
      return true;
    }
    toast("Release failed: " + (resp && resp.error || "unknown"), 5000);
    return false;
  } catch (err) {
    toast("Release failed: " + (err.message || err), 5000);
    return false;
  }
}

async function releaseCurrentLock() {
  // Contextual: releases the current team's lock when we hold it, otherwise
  // releases everything we hold (matching the button label in
  // syncTeamPickerLockUI).
  if (state.myLocks.length === 0) { toast("No lock held.", 2000); return; }
  const currentTeam = (state.currentTeam || "").trim().toUpperCase();
  const single = holdsLock(currentTeam) ? currentTeam : null;
  const pending = state.editedRowKeys.size > 0;
  const what = single || heldTeams().join(", ");
  if (pending && !confirm(`You have ${state.edits.length} unsynced edit(s). Release ${what} anyway? Edits stay in your browser.`)) return;
  if (single) await releaseLock(single);
  else await releaseAllLocks();
  syncTeamPickerLockUI();
}

async function acquireCurrentTeamLock() {
  const team = (state.currentTeam || "").trim().toUpperCase();
  if (!team) return;
  if (team === FA_TEAM) { toast("FA isn't locked — edits go straight in.", 3000); return; }
  if (holdsLock(team)) { toast("You already hold " + team + ".", 2000); return; }
  // Locks are additive — holding other teams is fine; sync needs one per
  // team touched.
  await acquireLock(team);
  syncTeamPickerLockUI();
}

function onTeamSelectChange(e) {
  // Switching teams is read-only navigation. No lock work happens here.
  // Use the explicit "Lock team" button to acquire an edit lock; users
  // can browse any team freely without taking a lock.
  const desired = (e.target.value || "").trim().toUpperCase();
  if (!desired || desired === (state.currentTeam || "").trim().toUpperCase()) return;
  commitTeamSwitch(desired);
}

function commitTeamSwitch(team) {
  state.currentTeam = team;
  state.currentCategory = null;
  try { localStorage.setItem(lsKeyTeam(), team); } catch {}
  const addTeamEl = document.getElementById("add-row-team");
  const addCustomEl = document.getElementById("add-custom-team");
  if (addTeamEl) addTeamEl.textContent = team;
  if (addCustomEl) addCustomEl.textContent = team;
  renderTeamView();
  syncTeamPickerLockUI();
}

function syncTeamPickerLockUI() {
  const sel = document.getElementById("team-select");
  if (!sel) return;
  const byTeam = new Map();
  for (const l of state.allLocks || []) {
    if (!l.expired) byTeam.set(l.team, l);
  }
  for (const opt of sel.options) {
    const t = (opt.value || "").trim().toUpperCase();
    const l = byTeam.get(t);
    // Switching teams is read-only navigation, so dropdown options are
    // never disabled; the lock badge is purely informational.
    opt.disabled = false;
    if (!l || t === FA_TEAM) {
      opt.textContent = opt.value;
    } else if (l.owner_email === state.authedEmail) {
      opt.textContent = opt.value + "  🔓 you";
    } else {
      opt.textContent = opt.value + "  🔒 " + l.owner_email;
    }
  }
  const releaseBtn = document.getElementById("release-lock-btn");
  const acquireBtn = document.getElementById("acquire-lock-btn");
  const heldBadge  = document.getElementById("lock-held-badge");
  const currentTeam = (state.currentTeam || "").trim().toUpperCase();
  const isFA = currentTeam === FA_TEAM;
  const heldByMeHere = holdsLock(currentTeam);
  const nHeld = state.myLocks.length;
  if (acquireBtn) {
    acquireBtn.style.display = (!heldByMeHere && !isFA && getSyncUrl()) ? "inline-flex" : "none";
    acquireBtn.textContent = "Lock " + currentTeam;
  }
  if (releaseBtn) {
    releaseBtn.style.display = nHeld > 0 ? "inline-flex" : "none";
    releaseBtn.textContent = heldByMeHere
      ? "Release " + currentTeam
      : (nHeld === 1 ? "Release " + state.myLocks[0].team : "Release all (" + nHeld + ")");
  }
  if (heldBadge) {
    if (nHeld > 0) {
      heldBadge.textContent = "🔓 " + heldTeams().join(", ");
      heldBadge.style.display = "inline-flex";
    } else {
      heldBadge.style.display = "none";
    }
  }
}

function renderLocksPanel() {
  const list = document.getElementById("locks-list");
  if (!list) return;
  list.innerHTML = "";
  const active = (state.allLocks || []).filter((l) => !l.expired);
  if (active.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nobody is locked into a team right now.";
    list.appendChild(li);
    return;
  }
  for (const l of active) {
    const li = document.createElement("li");
    const mine = l.owner_email === state.authedEmail;
    li.innerHTML = `<strong>${escapeHTML(l.team)}</strong>` +
      ` — ${escapeHTML(l.owner_email)}${mine ? " (you)" : ""}` +
      ` <span class="muted">${Math.floor((l.idle_seconds || 0) / 60)}m idle</span>`;
    list.appendChild(li);
  }
}

function maybeShowStaleSnapshotBanner(generatedAt) {
  if (!generatedAt) return;
  const ageMin = (Date.now() - new Date(generatedAt).getTime()) / 60000;
  if (ageMin < SNAPSHOT_STALE_MIN) return;
  const banner = document.getElementById("stale-snapshot-banner");
  if (!banner) return;
  banner.textContent =
    `Snapshot is ${Math.round(ageMin)} min old. Click Refresh before editing to avoid stale-write conflicts.`;
  banner.style.display = "block";
}

function onBeforeUnload(e) {
  if (state.myLocks.length > 0 && state.editedRowKeys.size > 0) {
    e.preventDefault();
    e.returnValue = "";
    return "";
  }
}

// ---------------------------------------------------------------------------
// Add player
// ---------------------------------------------------------------------------

function populateAddPositionDropdown() {
  // Populates BOTH add-player position dropdowns (Rosters-backed + custom).
  const opts = state.snapshot.options.position || [];
  for (const id of ["add-position", "add-custom-position"]) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "—";
    sel.appendChild(blank);
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      sel.appendChild(opt);
    }
  }
}

function nextPlaceholderId() {
  // Scan eliasIds for ROOKIE### in current rows + any edits already adding new ones.
  let max = 0;
  const seenIds = new Set();
  for (const r of state.rows) {
    if (r.eliasId) seenIds.add(String(r.eliasId).toUpperCase());
    if (r.gsisId)  seenIds.add(String(r.gsisId).toUpperCase());
  }
  for (const id of seenIds) {
    const m = id.match(/^ROOKIE(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `ROOKIE${String(max + 1).padStart(3, "0")}`;
}

function populateRosterSuggestions() {
  // Pulls the *full* Rosters tab and exposes it as a datalist. Labels show
  // "Name (TEAM)" so the user can disambiguate two players with the same
  // name on different teams.
  const list = document.getElementById("roster-suggestions");
  list.innerHTML = "";
  const rosters = state.snapshot.rosters;
  if (!rosters || !rosters.rows) return;
  const nameIdx = rosters.headers.indexOf("displayName");
  const teamIdx = rosters.headers.indexOf("teamAbbreviation");
  if (nameIdx < 0) return;
  const seen = new Set();
  for (const r of rosters.rows) {
    const n = r[nameIdx];
    if (!n) continue;
    const t = teamIdx >= 0 ? (r[teamIdx] || "") : "";
    const key = `${n}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = document.createElement("option");
    o.value = n;
    if (t) o.label = `${n} (${t})`;
    list.appendChild(o);
  }
}

function _rosterMatch(name) {
  // Strict: returns the Rosters row whose displayName matches exactly, or null.
  const rosters = state.snapshot.rosters;
  if (!rosters || !rosters.rows) return null;
  const nameIdx = rosters.headers.indexOf("displayName");
  if (nameIdx < 0) return null;
  const match = rosters.rows.find(r => r[nameIdx] === name);
  if (!match) return null;
  const idx = (k) => rosters.headers.indexOf(k);
  return {
    displayName: name,
    eliasId:   idx("esbId")   >= 0 ? (match[idx("esbId")]   || "") : "",
    gsisId:    idx("gsisId")  >= 0 ? (match[idx("gsisId")]  || "") : "",
    firstName: idx("firstName") >= 0 ? (match[idx("firstName")] || "") : "",
    lastName:  idx("lastName")  >= 0 ? (match[idx("lastName")]  || "") : "",
    jersey:    idx("jersey")  >= 0 ? (match[idx("jersey")]  || "") : "",
    teamAbbreviation: idx("teamAbbreviation") >= 0 ? (match[idx("teamAbbreviation")] || "") : "",
  };
}

function onAddPlayer() {
  const team = state.currentTeam;
  if (!canEditTeam(team)) { toast(lockGateMessage({ team }), 4000); return; }
  const name = document.getElementById("add-player-search").value.trim();
  const pos  = document.getElementById("add-position").value;
  const cat  = document.getElementById("add-category").value;
  if (!name) { toast("Pick a player from the Rosters list."); return; }

  // Strict: the typed/selected name must exist in Rosters. Refusing free
  // text prevents typos and forces the "register a placeholder" workflow to
  // be the explicit way to add unsigned/rookie players.
  const r = _rosterMatch(name);
  if (!r) {
    toast(`"${name}" is not in the Rosters tab. Refresh the snapshot or pick from the suggestions.`);
    return;
  }

  // footballName = first whitespace-separated token of displayName (mirrors
  // the LEFT(F, FIND(" ", F)-1) formula in the sheet).
  const footballName = r.firstName || (name.split(/\s+/)[0] || "");

  // Allocate a virtual sheet_row above all existing data.
  const maxRow = Math.max(...state.rows.map(r => Number(r._sheet_row) || 0), 100000);
  const newRow = {
    _sheet_row: maxRow + 1,
    team,
    displayName: name,
    firstName: r.firstName,
    lastName: r.lastName,
    footballName,
    position: pos,
    depthPosition: pos,            // default to the position; user can refine to LWR/SWR/RWR
    depthPositionCategory: cat,
    eliasId: r.eliasId,
    gsisId: r.gsisId,
    jersey: r.jersey,
    _new: true,
  };
  state.rows.push(newRow);

  // Log each non-empty field as an "edit" so the diff/export sees the new row.
  const ts = new Date().toISOString();
  const fields = [
    "team", "displayName", "firstName", "lastName", "footballName",
    "position", "depthPosition", "depthPositionCategory",
    "eliasId", "gsisId", "jersey",
  ];
  for (const k of fields) {
    if (newRow[k] === "" || newRow[k] === undefined) continue;
    state.edits.push({ sheet_row: newRow._sheet_row, column: k, before: "", after: newRow[k], ts, who: state.authedEmail || "anon", ident: editIdentity(newRow) });
  }
  state.editedRowKeys.add(newRow._sheet_row);
  persistEdits();
  updateEditCount();
  renderTeamView();
  document.getElementById("add-player-search").value = "";
  toast(`Added ${name} to ${team} (in-memory).`);
}

function onAddCustomPlayer() {
  const team = state.currentTeam;
  if (!canEditTeam(team)) { toast(lockGateMessage({ team }), 4000); return; }
  const name = document.getElementById("add-custom-name").value.trim();
  const pos  = document.getElementById("add-custom-position").value;
  const cat  = document.getElementById("add-custom-category").value;
  const jersey = document.getElementById("add-custom-jersey").value.trim();
  let eliasId = document.getElementById("add-custom-elias").value.trim();
  let gsisId  = document.getElementById("add-custom-gsis").value.trim();

  if (!name) { toast("Custom player needs at least a name."); return; }
  if (!pos)  { toast("Pick a position for the custom player."); return; }

  // Default any blank ID field to the next ROOKIE### slot. If only one of
  // the two is blank, reuse the other so the row keeps the same number.
  if (!eliasId && !gsisId) {
    eliasId = nextPlaceholderId();
    gsisId  = eliasId;
  } else if (!eliasId) {
    eliasId = /^ROOKIE\d+$/i.test(gsisId) ? gsisId.toUpperCase() : nextPlaceholderId();
  } else if (!gsisId) {
    gsisId  = /^ROOKIE\d+$/i.test(eliasId) ? eliasId.toUpperCase() : nextPlaceholderId();
  }

  // Derive name parts.
  const tokens = name.split(/\s+/).filter(Boolean);
  const firstName = tokens[0] || "";
  const lastName  = tokens.length > 1 ? tokens.slice(1).join(" ") : "";
  const footballName = firstName;

  // Allocate a virtual sheet_row above all existing data.
  const maxRow = Math.max(...state.rows.map(r => Number(r._sheet_row) || 0), 100000);
  const newRow = {
    _sheet_row: maxRow + 1,
    team,
    displayName: name,
    firstName,
    lastName,
    footballName,
    position: pos,
    depthPosition: pos,
    depthPositionCategory: cat,
    eliasId,
    gsisId,
    jersey,
    _new: true,
    _custom: true,
  };
  state.rows.push(newRow);

  const ts = new Date().toISOString();
  const fields = [
    "team", "displayName", "firstName", "lastName", "footballName",
    "position", "depthPosition", "depthPositionCategory",
    "eliasId", "gsisId", "jersey",
  ];
  for (const k of fields) {
    if (newRow[k] === "" || newRow[k] === undefined) continue;
    state.edits.push({
      sheet_row: newRow._sheet_row, column: k,
      before: "", after: newRow[k], ts,
      who: state.authedEmail || "anon",
      ident: editIdentity(newRow),
    });
  }
  state.editedRowKeys.add(newRow._sheet_row);
  persistEdits();
  updateEditCount();
  renderTeamView();

  // Reset the custom form.
  document.getElementById("add-custom-name").value = "";
  document.getElementById("add-custom-jersey").value = "";
  document.getElementById("add-custom-elias").value = "";
  document.getElementById("add-custom-gsis").value = "";

  toast(`Added ${name} to ${team} (Elias=${eliasId}, GSIS=${gsisId}).`);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportSyncJSON() {
  // Format consumed by tools/sync_to_sheet.py — every row in current state
  // plus the keys/labels list so the script can map JSON keys to columns.
  const keys = state.snapshot.depth.keys.slice();
  const labelMap = state.snapshot.depth.key_to_label || {};
  // Strip the in-memory bookkeeping fields (anything that starts with "_")
  // EXCEPT _sheet_row which the script needs as the row identifier.
  const rows = state.rows.map(r => {
    const out = {};
    for (const k of Object.keys(r)) {
      if (k === "_sheet_row" || !k.startsWith("_")) out[k] = r[k];
    }
    return out;
  });
  // Sort by sheet_row for stable diffs.
  rows.sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));

  const payload = {
    exported_at: new Date().toISOString(),
    snapshot_at: state.snapshot.generated_at,
    editor: state.authedEmail || "anon",
    keys, labels: labelMap,
    edit_count: state.edits.length,
    edited_row_count: state.editedRowKeys.size,
    rows,
  };
  download("sync_export.json", JSON.stringify(payload), "application/json");
  toast("sync_export.json downloaded. Run: python tools/sync_to_sheet.py sync_export.json", 8000);
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
// Warnings (transactions vs current depth chart, OurLads vs current chart)
// ---------------------------------------------------------------------------
//
// Read-only: warnings never mutate the depth chart. The user fixes the
// underlying row manually (and the warning then disappears on next rebuild)
// or dismisses the warning (id stored in localStorage so it stays gone).

const TX_KEY_FIELDS = [
  "date", "transactionType", "teamAbbr",
  "person_displayName", "person_gsisId",
];

function _txField(row, headers, name) {
  const i = headers.indexOf(name);
  return i >= 0 && i < row.length ? (row[i] || "") : "";
}

function _normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,'’`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function _daysAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (24 * 3600 * 1000);
}

function _rowsByName() {
  // Index current rows by normalized displayName so warnings can find them
  // even when displayName has minor punctuation differences.
  const map = new Map();
  for (const r of state.rows) {
    const k = _normalizeName(r.displayName);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function _rowsByGsisId() {
  const map = new Map();
  for (const r of state.rows) {
    const g = (r.gsisId || "").trim();
    if (!g) continue;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(r);
  }
  return map;
}

// --- Transaction warnings --------------------------------------------------

function computeTransactionWarnings() {
  // Prefer the standalone transactions.json (ESPN public API, fresh).
  // Fall back to whatever the snapshot loaded from Transactions_New.
  const tx = (state.transactions && state.transactions.rows)
    ? state.transactions
    : state.snapshot.transactions;
  if (!tx || !tx.rows || !tx.headers) return [];
  const headers = tx.headers;
  const byName = _rowsByName();
  const byGsis = _rowsByGsisId();
  const out = [];

  for (const r of tx.rows) {
    const date = _txField(r, headers, "date");
    if (_daysAgo(date) > TRANSACTION_WARN_DAYS) continue;

    const type      = _txField(r, headers, "transactionType");
    const teamAbbr  = _txField(r, headers, "teamAbbr");
    const name      = _txField(r, headers, "person_displayName");
    const gsisId    = _txField(r, headers, "person_gsisId");
    const desc      = _txField(r, headers, "description");

    if (!name && !gsisId) continue;

    // Find matching rows. Prefer gsisId, fall back to normalized name.
    let matches = [];
    if (gsisId && byGsis.has(gsisId)) matches = byGsis.get(gsisId);
    if (matches.length === 0 && name) matches = byName.get(_normalizeName(name)) || [];

    const expect = _expectedStateForTx(type, teamAbbr);
    if (!expect) continue;

    const id = `tx|${date}|${(gsisId || _normalizeName(name)).replace(/\s+/g, "_")}|${type}`;
    // NFL.com uses ARI/BAL/CLE/HOU/OAK/LAR; the chart uses ARZ/BLT/CLV/HST/LV/LA.
    // Display the chart's abbreviation everywhere so a user scanning by team
    // sees the same code they use in the picker.
    const displayTeam = _normalizeTeam(teamAbbr) || teamAbbr;

    if (matches.length === 0) {
      // Player not present in our chart at all.
      if (expect.shouldExistOnTeam) {
        out.push({
          id, source: "transactions",
          team: displayTeam, player: name || gsisId,
          date,
          title: `${expect.label}: not in chart`,
          detail: `${date}: ${desc || type}. No row in DepthCharts for ${name || gsisId}.`,
        });
      }
      continue;
    }

    // Check expectation against each matching row.
    for (const row of matches) {
      const mismatch = _diagnoseMismatch(row, expect);
      if (!mismatch) continue;
      out.push({
        id,
        source: "transactions",
        team: displayTeam,
        player: name || row.displayName,
        date,
        title: `${expect.label}: ${mismatch.summary}`,
        detail: `${date}: ${desc || type}. ${mismatch.detail}`,
        navigate: { team: row.team || teamAbbr, sheet_row: row._sheet_row },
      });
    }
  }
  return out;
}

function _expectedStateForTx(type, teamAbbr) {
  const t = (type || "").toLowerCase();
  if (t === "signings" || t === "practice-squad" || t === "active-roster") {
    return {
      label: t === "practice-squad" ? "Signed to PS" : "Signed",
      shouldExistOnTeam: true,
      teamShouldBe: teamAbbr,
      statusContains: t === "practice-squad" ? "PS" : null,
    };
  }
  if (t === "reserve-list") {
    return {
      label: "On IR per NFL.com",
      shouldExistOnTeam: true,
      teamShouldBe: teamAbbr,
      statusContains: "IR",
    };
  }
  if (t === "released" || t === "waivers" || t === "waived") {
    return {
      label: "Released per NFL.com",
      shouldExistOnTeam: false,
      teamShouldBe: "FA",
    };
  }
  if (t === "trades") {
    return {
      label: "Traded",
      shouldExistOnTeam: true,
      teamShouldBe: teamAbbr,
    };
  }
  if (t === "suspensions" || t === "suspended") {
    return {
      label: "Suspended per NFL.com",
      teamShouldBe: teamAbbr,
      statusContains: "SUS",
    };
  }
  return null;
}

function _diagnoseMismatch(row, expect) {
  // teamShouldBe: row.team must equal the expected team. "FA" is special.
  if (expect.teamShouldBe) {
    const t = (row.team || "").toUpperCase();
    const e = expect.teamShouldBe.toUpperCase();
    if (t !== e && _normalizeTeam(t) !== _normalizeTeam(e)) {
      // Show the chart-side abbreviation for the expected team so the
      // mismatch text uses the same code the user sees in their chart.
      const expectDisplay = _normalizeTeam(expect.teamShouldBe) || expect.teamShouldBe;
      return {
        summary: `team ${row.team || "(blank)"} != ${expectDisplay}`,
        detail: `Row shows team=${row.team || "(blank)"} but transaction expects ${expectDisplay}.`,
      };
    }
  }
  if (expect.statusContains) {
    const s = (row.status || row.statusDescription || "").toUpperCase();
    if (!s.includes(expect.statusContains)) {
      return {
        summary: `status missing "${expect.statusContains}"`,
        detail: `Row shows status="${row.status || "(blank)"}". Expected to contain "${expect.statusContains}".`,
      };
    }
  }
  return null;
}

function _normalizeTeam(t) {
  // Some sheets use TV abbrevs (ARZ/BLT/CLV/HST/JAX/LA) where NFL.com uses
  // ARI/BAL/CLE/HOU/JAX/LA. Treat these as the same.
  const m = {
    ARI: "ARZ", ARZ: "ARZ",
    BAL: "BLT", BLT: "BLT",
    CLE: "CLV", CLV: "CLV",
    HOU: "HST", HST: "HST",
    JAC: "JAX", JAX: "JAX",
    LA:  "LA",  LAR: "LA",
    OAK: "LV",  LV:  "LV",
  };
  const u = String(t || "").toUpperCase();
  return m[u] || u;
}

// --- OurLads warnings ------------------------------------------------------

function computeOurladsWarnings() {
  const ol = state.ourlads;
  if (!ol || !ol.teams) return [];
  const byName = _rowsByName();
  const out = [];

  // OurLads schema (matches the scraper output below):
  // { generated_at, teams: { "ARZ": [ {name, position, depth_position, depth_order}, ... ], ... } }

  for (const [team, players] of Object.entries(ol.teams)) {
    for (const p of players) {
      let key = _normalizeName(p.name);
      if (!key) continue;
      // Shared alias: a known OurLads spelling difference resolves to the
      // chart's name before matching, so team/position checks still run.
      const alias = state.nameAliases[key];
      if (alias && alias.sheet_name) key = _normalizeName(alias.sheet_name);
      const matches = byName.get(key) || [];

      if (matches.length === 0) {
        const id = `ol|missing|${_normalizeTeam(team)}|${key.replace(/\s+/g,"_")}`;
        out.push({
          id, source: "ourlads",
          team, player: p.name, olName: p.name,
          title: `OurLads: present on ${team} ${p.position || ""}${p.depth_order ? "#" + p.depth_order : ""}`,
          detail: `OurLads lists ${p.name} on ${team} (${p.position || "?"}${p.depth_position ? " / " + p.depth_position : ""}). No row in DepthCharts.` +
                  (alias ? ` (Linked name "${alias.sheet_name}" no longer matches any row.)` : ""),
        });
        continue;
      }

      // Find a row on the same team if available.
      const rowOnTeam = matches.find(r => _normalizeTeam(r.team) === _normalizeTeam(team)) || matches[0];

      if (_normalizeTeam(rowOnTeam.team) !== _normalizeTeam(team)) {
        const id = `ol|team|${_normalizeTeam(team)}|${key.replace(/\s+/g,"_")}`;
        out.push({
          id, source: "ourlads",
          team, player: p.name,
          title: `Team mismatch (OurLads ${team} vs ${rowOnTeam.team})`,
          detail: `OurLads shows ${p.name} on ${team}; DepthCharts has ${rowOnTeam.team}.`,
          navigate: { team: rowOnTeam.team, sheet_row: rowOnTeam._sheet_row },
        });
        continue;
      }

      // Position mismatch.
      const olPos = (p.position || "").toUpperCase();
      const rowPos = (rowOnTeam.position || "").toUpperCase();
      if (olPos && rowPos && olPos !== rowPos) {
        const id = `ol|pos|${_normalizeTeam(team)}|${key.replace(/\s+/g,"_")}`;
        out.push({
          id, source: "ourlads",
          team, player: p.name,
          title: `Position mismatch (OurLads ${olPos} vs ${rowPos})`,
          detail: `OurLads shows ${p.name} as ${olPos}; DepthCharts has ${rowPos}.`,
          navigate: { team: rowOnTeam.team, sheet_row: rowOnTeam._sheet_row },
        });
      }
    }
  }
  return out;
}

// --- Orchestration ---------------------------------------------------------

function rebuildWarnings() {
  state.warnings = [
    ...computeTransactionWarnings(),
    ...computeOurladsWarnings(),
  ];
  renderWarnings();
  renderSourceFreshness();
}

function renderSourceFreshness() {
  const txEl = document.getElementById("warnings-src-tx");
  const olEl = document.getElementById("warnings-src-ourlads");
  if (txEl) {
    const tx = state.transactions || state.snapshot?.transactions;
    if (!tx || !tx.rows || !tx.rows.length) {
      txEl.textContent = "Transactions: no data loaded.";
      txEl.className = "stale";
    } else {
      const generated = (state.transactions && state.transactions.generated_at) || state.snapshot?.generated_at;
      const newest = _newestTxDate(tx);
      const newestDays = newest ? _daysAgo(newest) : null;
      const genDays = generated ? Math.floor((Date.now() - new Date(generated).getTime()) / 86400000) : null;
      const source = state.transactions ? (state.transactions.source || "espn") : "sheet";
      const fresh = newestDays !== null && newestDays <= 7;
      const stale = newestDays !== null && newestDays > 30;
      txEl.textContent =
        `Transactions: ${tx.rows.length} rows from ${source}, newest ${newest || "?"}` +
        (newestDays !== null ? ` (${newestDays}d ago)` : "") +
        (genDays !== null && genDays > 0 ? `, file ${genDays}d old` : "");
      txEl.className = fresh ? "fresh" : (stale ? "stale" : "muted");
    }
  }
  if (olEl) {
    const teams = state.ourlads && state.ourlads.teams;
    if (!teams) {
      olEl.textContent = "OurLads: no snapshot loaded.";
      olEl.className = "muted";
    } else {
      const generated = state.ourlads.generated_at;
      const days = generated ? Math.floor((Date.now() - new Date(generated).getTime()) / 86400000) : null;
      const nPlayers = Object.values(teams).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
      olEl.textContent =
        `OurLads: ${nPlayers} players across ${Object.keys(teams).length} teams` +
        (generated ? `, scraped ${_fmtAgo(generated)}` : "");
      olEl.className = days !== null && days > 7 ? "stale" : "muted";
    }
  }
}

function _newestTxDate(tx) {
  const idx = tx.headers.indexOf("date");
  if (idx < 0) return null;
  let max = "";
  for (const r of tx.rows) {
    const d = r[idx];
    if (d && d > max) max = d;
  }
  return max || null;
}

async function refreshExternalSources() {
  const btn = document.getElementById("warnings-refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  try {
    const [fresh_tx, fresh_ol] = await Promise.all([
      tryFetchJSON("./data/transactions.json?cb=" + Date.now()),
      tryFetchJSON("./data/ourlads.json?cb=" + Date.now()),
    ]);
    let n = 0;
    if (fresh_tx) { state.transactions = fresh_tx; n++; }
    if (fresh_ol) { state.ourlads = fresh_ol; n++; }
    // Shared aliases may have changed too; rebuilds warnings again on landing.
    refreshNameAliases();
    rebuildWarnings();
    updateOurladsBadge();
    renderOurladsPanel();
    const active = state.warnings.filter(w => !state.dismissedWarningIds.has(w.id)).length;
    toast(`Sources refreshed (${n}/2). ${active} active warning${active === 1 ? "" : "s"}.`, 3500);
  } catch (err) {
    toast("Refresh failed: " + (err.message || err), 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh sources"; }
  }
}

function renderWarnings() {
  const list = document.getElementById("warnings-list");
  if (!list) return;

  const dismissed = state.dismissedWarningIds;
  const active   = state.warnings.filter(w => !dismissed.has(w.id));
  const visible  = state.warnings.filter(w => {
    switch (state.warningFilter) {
      case "transactions": return !dismissed.has(w.id) && w.source === "transactions";
      case "ourlads":      return !dismissed.has(w.id) && w.source === "ourlads";
      case "dismissed":    return dismissed.has(w.id);
      default:             return !dismissed.has(w.id);
    }
  });

  // Update toggle.
  const toggle = document.getElementById("warnings-toggle");
  const countSpan = document.getElementById("warnings-count");
  if (toggle && countSpan) {
    countSpan.textContent = String(active.length);
    if (active.length > 0) {
      toggle.style.display = "inline-flex";
      toggle.classList.add("has-active");
    } else if (state.warnings.length > 0) {
      // No active but some dismissed exist — keep the badge visible at 0.
      toggle.style.display = "inline-flex";
      toggle.classList.remove("has-active");
    } else {
      toggle.style.display = "none";
    }
  }

  // Filter chip active state.
  for (const chip of document.querySelectorAll("#warnings-filters .chip")) {
    chip.classList.toggle("chip--active", chip.dataset.filter === state.warningFilter);
  }

  // Body.
  list.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "warnings-empty";
    empty.textContent = state.warningFilter === "dismissed"
      ? "No dismissed warnings."
      : "All clear — no external-source warnings.";
    list.appendChild(empty);
    return;
  }

  // Sort: undismissed first, then newest transaction date first (so a fresh
  // signing review surfaces today's moves at the top), then by team and
  // source as tiebreakers so same-team warnings still cluster within a day.
  // OurLads warnings have no date — fall back to "" which sorts after dated
  // rows under desc compare.
  visible.sort((a, b) => {
    const da = dismissed.has(a.id) ? 1 : 0;
    const db = dismissed.has(b.id) ? 1 : 0;
    if (da !== db) return da - db;
    const dateA = a.date || "";
    const dateB = b.date || "";
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    if (a.team !== b.team) return (a.team || "").localeCompare(b.team || "");
    return (a.source || "").localeCompare(b.source || "");
  });

  for (const w of visible) {
    list.appendChild(renderWarning(w, dismissed.has(w.id)));
  }
}

function renderWarning(w, isDismissed) {
  const el = document.createElement("article");
  el.className = "warning warning--" + w.source + (isDismissed ? " warning--dismissed" : "");

  const head = document.createElement("div");
  head.className = "warning__head";
  const src = document.createElement("span");
  src.className = "warning__source";
  src.textContent = w.source === "ourlads" ? "OurLads" : "NFL.com TX";
  const team = document.createElement("span");
  team.className = "warning__team";
  team.textContent = w.team || "—";
  head.append(src, team);
  if (w.date) {
    const date = document.createElement("span");
    date.className = "warning__team";
    date.textContent = w.date;
    head.append(date);
  }
  el.appendChild(head);

  const title = document.createElement("h3");
  title.className = "warning__title";
  title.textContent = `${w.player || "?"} — ${w.title}`;
  el.appendChild(title);

  const detail = document.createElement("p");
  detail.className = "warning__detail";
  detail.textContent = w.detail || "";
  el.appendChild(detail);

  const actions = document.createElement("div");
  actions.className = "warning__actions";

  if (w.navigate) {
    const fix = document.createElement("button");
    fix.className = "btn btn--primary";
    fix.textContent = "Go to row";
    fix.addEventListener("click", () => navigateToRow(w.navigate));
    actions.appendChild(fix);
  }

  if (w.olName) {
    // Missing-player warning: offer a one-time shared alias instead of a
    // per-browser dismissal, so the spelling difference stops warning for
    // everyone and team/position checks keep working for this player.
    const link = document.createElement("button");
    link.className = "btn btn--ghost";
    link.textContent = "Link to player…";
    link.title = "Map this OurLads spelling to an existing DepthCharts player (shared with all editors)";
    link.addEventListener("click", () => linkOurladsName(w));
    actions.appendChild(link);
  }

  const toggle = document.createElement("button");
  toggle.className = "btn btn--ghost";
  toggle.textContent = isDismissed ? "Restore" : "Dismiss";
  toggle.addEventListener("click", () => {
    if (isDismissed) state.dismissedWarningIds.delete(w.id);
    else             state.dismissedWarningIds.add(w.id);
    persistDismissedWarnings();
    renderWarnings();
  });
  actions.appendChild(toggle);
  el.appendChild(actions);

  return el;
}

function navigateToRow(target) {
  if (!target) return;
  openWarnings(false);
  if (target.team && target.team !== state.currentTeam) {
    // Warnings-driven navigation is read-only: switch view without acquiring
    // a lock. Edits on the destination team will still be blocked until the
    // user explicitly clicks "Lock team".
    state.currentTeam = target.team;
    state.currentCategory = null;
    try { localStorage.setItem(lsKeyTeam(), state.currentTeam); } catch {}
    document.getElementById("team-select").value = state.currentTeam;
    document.getElementById("add-row-team").textContent = state.currentTeam;
    document.getElementById("add-custom-team").textContent = state.currentTeam;
    syncTeamPickerLockUI();
  }

  // Find the row, switch its category if needed, then highlight.
  const row = state.rows.find(r => Number(r._sheet_row) === Number(target.sheet_row));
  if (row && row.depthPositionCategory) {
    state.currentCategory = row.depthPositionCategory;
  }
  renderTeamView();

  // After render, find and flash the row.
  setTimeout(() => {
    const trs = document.querySelectorAll(".tbl tbody tr");
    for (const tr of trs) {
      // Match by depthOrder + displayName cells (rough but works).
      if (tr.dataset.sheetRow == String(target.sheet_row)) {
        tr.scrollIntoView({ behavior: "smooth", block: "center" });
        tr.classList.add("row--warning-highlight");
        setTimeout(() => tr.classList.remove("row--warning-highlight"), 3500);
        break;
      }
    }
  }, 80);
}

function openWarnings(open) {
  const panel = document.getElementById("warnings-panel");
  const scrim = document.getElementById("warnings-scrim");
  if (!panel || !scrim) return;
  panel.classList.toggle("is-open", !!open);
  scrim.classList.toggle("is-open", !!open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  scrim.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) renderWarnings();
}

function persistDismissedWarnings() {
  try {
    localStorage.setItem(lsKeyDismissed(), JSON.stringify([...state.dismissedWarningIds]));
  } catch (err) {
    console.warn("dismiss persistence failed", err);
  }
}
function restoreDismissedWarnings() {
  try {
    const raw = localStorage.getItem(lsKeyDismissed());
    if (!raw) return;
    state.dismissedWarningIds = new Set(JSON.parse(raw) || []);
  } catch {}
}

// ---------------------------------------------------------------------------
// OurLads update tracker
// ---------------------------------------------------------------------------
//
// OurLads prints "Updated: MM/DD/YYYY H:MMPM ET" at the top of every team
// page. The hourly scrape stores it in ourlads.json as `updates[team]` =
// { text, iso }. The Apps Script keeps an `OurladsChecks` tab recording who
// on our side last reviewed each team and which OurLads stamp they saw. A
// team "needs re-check" when OurLads' stamp is newer than our last check —
// or when nobody has checked it yet.

function _olUpdates() {
  return (state.ourlads && state.ourlads.updates) || {};
}

function _olTeamName(abbr) {
  return OL_TEAM_NAMES[abbr] || abbr;
}

function _olTeams() {
  // Every team in the chart except FA, plus anything OurLads knows that the
  // chart doesn't (shouldn't happen; don't hide data if it does).
  const set = new Set(teamList().filter((t) => t !== FA_TEAM));
  for (const t of Object.keys(_olUpdates())) set.add(t);
  return [...set].sort((a, b) => _olTeamName(a).localeCompare(_olTeamName(b)));
}

// → "recheck" | "checked" | "unknown"
function olTeamStatus(team) {
  const upd = _olUpdates()[team];
  const chk = state.olChecks[team];
  if (!chk || !chk.checked_at) return "recheck";            // never reviewed
  if (!upd || !upd.iso) return "unknown";                     // no comparable stamp
  // Exact stamp match beats clock comparison (robust to skew / future stamps).
  if (chk.ourlads_updated_at && chk.ourlads_updated_at === upd.iso) return "checked";
  const u = Date.parse(upd.iso);
  const c = Date.parse(chk.checked_at);
  if (!Number.isFinite(u) || !Number.isFinite(c)) return "unknown";
  return u > c ? "recheck" : "checked";
}

function olCountRecheck() {
  return _olTeams().filter((t) => olTeamStatus(t) === "recheck").length;
}

function updateOurladsBadge() {
  const btn = document.getElementById("ourlads-toggle");
  const count = document.getElementById("ourlads-count");
  if (!btn || !count) return;
  btn.style.display = "inline-flex";
  const n = olCountRecheck();
  count.textContent = String(n);
  btn.classList.toggle("has-active", n > 0);
  btn.title = n > 0
    ? `OurLads tracker — ${n} team${n === 1 ? "" : "s"} changed on OurLads since last checked`
    : "OurLads tracker — every team reviewed since its last OurLads update";
}

async function refreshOurladsChecks() {
  const url = getSyncUrl();
  if (!url) {
    state.olChecksError = "No Apps Script URL configured (Settings ⚙).";
    updateOurladsBadge();
    renderOurladsPanel();
    return;
  }
  try {
    const qs = "?action=listOurladsChecks&id_token=" + encodeURIComponent(state.idToken || "");
    const resp = await fetch(url + qs, { redirect: "follow" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const body = await resp.json();
    if (!body || !body.ok) throw new Error(formatSyncError(body));
    const map = {};
    for (const c of body.checks || []) {
      if (c && c.team) map[String(c.team).trim().toUpperCase()] = c;
    }
    state.olChecks = map;
    state.olChecksFetchedAt = Date.now();
    state.olChecksError = null;
  } catch (err) {
    console.warn("refreshOurladsChecks failed:", err);
    state.olChecksError = err.message || String(err);
  }
  updateOurladsBadge();
  renderOurladsPanel();
}

async function refreshNameAliases() {
  const url = getSyncUrl();
  if (!url) return; // Settings not configured; aliases just don't apply yet.
  try {
    const qs = "?action=listNameAliases&id_token=" + encodeURIComponent(state.idToken || "");
    const resp = await fetch(url + qs, { redirect: "follow" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const body = await resp.json();
    if (!body || !body.ok) throw new Error(formatSyncError(body));
    const map = {};
    for (const a of body.aliases || []) {
      const key = _normalizeName(a && a.ourlads_name);
      if (key && a.sheet_name) map[key] = a;
    }
    state.nameAliases = map;
    rebuildWarnings();
  } catch (err) {
    console.warn("refreshNameAliases failed:", err);
  }
}

// "Link to player…" on an OurLads missing-player warning: record a shared
// alias so this OurLads spelling maps to an existing DepthCharts player for
// every editor, then recompute warnings.
async function linkOurladsName(w) {
  const input = prompt(
    `OurLads lists "${w.olName}" (${w.team}) but no DepthCharts row matches.\n` +
    `Type the player's exact DepthCharts name to link them:`,
    w.olName
  );
  if (input == null) return;
  const key = _normalizeName(input);
  if (!key) return;
  const rows = _rowsByName().get(key) || [];
  if (rows.length === 0) {
    toast(`No DepthCharts row named "${input.trim()}". Check the spelling in the chart and try again.`, 6000);
    return;
  }
  const target = rows[0].displayName;
  toast(`Linking "${w.olName}" → "${target}"…`, Infinity);
  try {
    const resp = await _postToSync({
      action: "addNameAlias",
      ourlads_name: w.olName,
      sheet_name: target,
    });
    if (!resp || !resp.ok || !resp.alias) throw new Error(formatSyncError(resp));
    state.nameAliases[_normalizeName(resp.alias.ourlads_name)] = resp.alias;
    rebuildWarnings();
    toast(`Linked "${w.olName}" → "${target}" for all editors.`, 4000);
  } catch (err) {
    toast("Couldn't save the link: " + (err.message || err), 6000);
  }
}

async function markOurladsChecked(team) {
  if (!team || state.olMarking.has(team)) return;
  const upd = _olUpdates()[team] || {};
  state.olMarking.add(team);
  renderOurladsPanel();
  try {
    const resp = await _postToSync({
      action: "markOurladsChecked",
      team,
      ourlads_updated_at: upd.iso || "",
      ourlads_updated_text: upd.text || "",
    });
    if (!resp || !resp.ok || !resp.check) throw new Error(formatSyncError(resp));
    state.olChecks[team] = resp.check;
    toast(`${_olTeamName(team)} marked checked.`, 2500);
  } catch (err) {
    toast(`Couldn't mark ${team} checked: ${err.message || err}`, 6000);
  } finally {
    state.olMarking.delete(team);
    updateOurladsBadge();
    renderOurladsPanel();
  }
}

async function refreshOurladsTracker() {
  const btn = document.getElementById("ourlads-refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  try {
    const fresh = await tryFetchJSON("./data/ourlads.json?cb=" + Date.now());
    if (fresh) {
      state.ourlads = fresh;
      rebuildWarnings();
    }
    await refreshOurladsChecks();
  } catch (err) {
    toast("Refresh failed: " + (err.message || err), 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

function openOurladsPanel(open) {
  const panel = document.getElementById("ourlads-panel");
  const scrim = document.getElementById("ourlads-scrim");
  if (!panel || !scrim) return;
  panel.classList.toggle("is-open", !!open);
  scrim.classList.toggle("is-open", !!open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  scrim.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) {
    renderOurladsPanel();
    if (Date.now() - state.olChecksFetchedAt > OL_CHECKS_MAX_AGE_MS) refreshOurladsChecks();
  }
}

// Read-only navigation to a team (no lock), same contract as navigateToRow.
function navigateToTeam(team) {
  if (!team || !teamList().includes(team)) return;
  if (team !== state.currentTeam) commitTeamSwitch(team);
  const sel = document.getElementById("team-select");
  if (sel) sel.value = team;
}

function renderOurladsPanel() {
  const list = document.getElementById("ourlads-list");
  if (!list) return;

  // Source freshness lines.
  const scrapeEl = document.getElementById("ourlads-src-scrape");
  const checksEl = document.getElementById("ourlads-src-checks");
  const ol = state.ourlads;
  if (scrapeEl) {
    if (!ol) {
      scrapeEl.textContent = "OurLads scrape: not loaded.";
      scrapeEl.className = "stale";
    } else {
      const n = Object.keys(_olUpdates()).length;
      const ageMs = ol.generated_at ? Date.now() - Date.parse(ol.generated_at) : NaN;
      scrapeEl.textContent =
        `OurLads scrape: ${n} team stamp${n === 1 ? "" : "s"}` +
        (ol.generated_at ? `, scraped ${_fmtAgo(ol.generated_at)}` : "") +
        (n === 0 ? " — file predates stamp capture; wait for the next hourly scrape" : "");
      // Hourly cron → anything past ~3h means the workflow is stuck.
      scrapeEl.className = Number.isFinite(ageMs) && ageMs > 3 * 3600 * 1000 ? "stale" : "muted";
    }
  }
  if (checksEl) {
    if (state.olChecksError) {
      checksEl.textContent = "Check log: " + state.olChecksError;
      checksEl.className = "stale";
    } else if (!state.olChecksFetchedAt) {
      checksEl.textContent = "Check log: loading…";
      checksEl.className = "muted";
    } else {
      const n = Object.keys(state.olChecks).length;
      checksEl.textContent =
        `Check log: ${n} team${n === 1 ? "" : "s"} on record, fetched ${_fmtAgo(new Date(state.olChecksFetchedAt).toISOString())}`;
      checksEl.className = "muted";
    }
  }

  // Filter chip active state.
  for (const chip of document.querySelectorAll("#ourlads-filters .chip")) {
    chip.classList.toggle("chip--active", (chip.dataset.filter || "all") === state.olFilter);
  }

  const teams = _olTeams().filter((t) => {
    const s = olTeamStatus(t);
    if (state.olFilter === "recheck") return s === "recheck";
    if (state.olFilter === "checked") return s !== "recheck";
    return true;
  });
  if (!teams.length) {
    list.innerHTML = `<div class="warnings-empty">${
      state.olFilter === "recheck" ? "Every team has been reviewed since its last OurLads update." : "Nothing to show."
    }</div>`;
    return;
  }

  const canMark = !!getSyncUrl() && !!state.idToken;
  const markTitle = canMark
    ? "Record that you just reviewed this team against OurLads"
    : "Sign in and configure the Apps Script URL (Settings ⚙) to record checks";

  const rows = teams.map((t) => {
    const s = olTeamStatus(t);
    const upd = _olUpdates()[t];
    const chk = state.olChecks[t];
    const marking = state.olMarking.has(t);

    const updCell = upd && upd.text
      ? `<span class="ol-stamp" title="${escapeHTML(upd.iso || "unparsed")}">${escapeHTML(upd.text)}</span>`
      : `<span class="muted">—</span>`;
    const chkCell = chk && chk.checked_at
      ? `<span class="ol-stamp" title="${escapeHTML(chk.checked_at)}">${escapeHTML(_fmtLocal(chk.checked_at))}</span>` +
        `<span class="ol-ago">${escapeHTML(_fmtAgo(chk.checked_at))}</span>`
      : `<span class="muted">never</span>`;
    const byCell = chk && chk.checked_by
      ? `<span title="${escapeHTML(chk.checked_by)}">${escapeHTML(_shortEmail(chk.checked_by))}</span>`
      : `<span class="muted">—</span>`;
    const label = marking ? "Saving…" : (s === "recheck" ? "Mark checked" : "Re-check");

    return `<tr class="ol-row ol-row--${s}" data-team="${escapeHTML(t)}">
      <td class="ol-team">
        <button type="button" class="ol-team-link" data-nav="${escapeHTML(t)}" title="Open ${escapeHTML(t)} in the editor">${escapeHTML(_olTeamName(t))}</button>
        <span class="ol-abbr">${escapeHTML(t)}</span>
      </td>
      <td class="ol-upd">${updCell}</td>
      <td class="ol-chk">${chkCell}</td>
      <td class="ol-by">${byCell}</td>
      <td class="ol-act">
        <button type="button" class="btn ${s === "recheck" ? "btn--primary" : "btn--ghost"} ol-mark" data-mark="${escapeHTML(t)}" ${canMark && !marking ? "" : "disabled"} title="${escapeHTML(markTitle)}">${label}</button>
      </td>
    </tr>`;
  }).join("");

  list.innerHTML = `
    <table class="ol-table">
      <thead><tr>
        <th>Team</th>
        <th>OurLads updated (ET)</th>
        <th>Last checked</th>
        <th>By</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function _fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function _fmtAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function _shortEmail(email) {
  return String(email || "").split("@")[0];
}

// ---------------------------------------------------------------------------
// Settings (Apps Script sync URL + target tab)
// ---------------------------------------------------------------------------

function getSyncUrl() {
  // A per-browser override (set in Settings) wins; otherwise fall back to the
  // sync_url baked into auth.config.json so the deploy works for every user
  // without anyone pasting a URL. The config field is optional.
  const override = (localStorage.getItem(LS_SYNC_URL) || "").trim();
  if (override) return override;
  return ((state.authConfig && state.authConfig.sync_url) || "").trim();
}
function getTargetTab() {
  const override = (localStorage.getItem(LS_TARGET_TAB) || "").trim();
  if (override) return override;
  return ((state.authConfig && state.authConfig.target_tab) || "").trim() || DEFAULT_TARGET_TAB;
}

function openSettings(open) {
  const panel = document.getElementById("settings-panel");
  const scrim = document.getElementById("settings-scrim");
  if (!panel || !scrim) return;
  if (open) {
    document.getElementById("settings-sync-url").value = getSyncUrl();
    document.getElementById("settings-target-tab").value = getTargetTab();
    document.getElementById("settings-status").textContent = "";
  }
  panel.classList.toggle("is-open", !!open);
  scrim.classList.toggle("is-open", !!open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  scrim.setAttribute("aria-hidden", open ? "false" : "true");
}

function onSaveSettings() {
  const url = document.getElementById("settings-sync-url").value.trim();
  const tab = document.getElementById("settings-target-tab").value.trim() || DEFAULT_TARGET_TAB;
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.*\/exec$/.test(url)) {
    setSettingsStatus("That doesn't look like an Apps Script /exec URL.", "error");
    return;
  }
  if (url) localStorage.setItem(LS_SYNC_URL, url);
  else     localStorage.removeItem(LS_SYNC_URL);
  localStorage.setItem(LS_TARGET_TAB, tab);
  setSettingsStatus("Saved.", "ok");
  // Newly-configured URL → poll immediately so the lock badges populate
  // without waiting for the 30 s interval.
  if (url) refreshLocks().catch(() => {});
}

function onClearSettings() {
  localStorage.removeItem(LS_SYNC_URL);
  localStorage.removeItem(LS_TARGET_TAB);
  document.getElementById("settings-sync-url").value = "";
  document.getElementById("settings-target-tab").value = "";
  setSettingsStatus("Cleared.", "ok");
}

async function onTestSync() {
  const url = document.getElementById("settings-sync-url").value.trim();
  if (!url) { setSettingsStatus("Enter a URL first.", "error"); return; }
  setSettingsStatus("Testing…", "muted");
  try {
    // Health check — the Apps Script's doGet returns a small JSON body.
    const r = await fetch(url, { method: "GET", redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (body && body.ok) {
      setSettingsStatus(
        `OK. Server time: ${body.time}. Default tab: ${body.default_target_tab}.`,
        "ok"
      );
    } else {
      setSettingsStatus("Reached the URL but didn't get the expected JSON.", "error");
    }
  } catch (err) {
    setSettingsStatus("Failed: " + (err && err.message || err), "error");
  }
}

function setSettingsStatus(msg, kind) {
  const el = document.getElementById("settings-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "settings-status settings-status--" + (kind || "muted");
}

// ---------------------------------------------------------------------------
// Sync to sheet (POSTs sync_export to the Apps Script web app)
// ---------------------------------------------------------------------------

function _buildSyncPayload(extra) {
  const keys = state.snapshot.depth.keys.slice();
  const labelMap = state.snapshot.depth.key_to_label || {};
  const rows = state.rows.map((r) => {
    const out = {};
    for (const k of Object.keys(r)) {
      if (k === "_sheet_row" || !k.startsWith("_")) out[k] = r[k];
    }
    // Baseline identity so the server can verify this sheet row still holds
    // the player we loaded (rows move when someone inserts/deletes in the
    // sheet). Virtual rows we added have no baseline and are appended anyway.
    const base = state.baseline.get(r._sheet_row);
    if (base && !isVirtualSheetRow(r._sheet_row)) {
      out._identity = {
        gsisId: base.gsisId ?? "", nflId: base.nflId ?? "",
        eliasId: base.eliasId ?? "", displayName: base.displayName ?? "",
      };
    }
    return out;
  });
  rows.sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));
  return Object.assign({
    exported_at: new Date().toISOString(),
    snapshot_at: state.snapshot.generated_at,
    editor: state.authedEmail || "anon",
    keys, labels: labelMap,
    edit_count: state.edits.length,
    edited_row_count: state.editedRowKeys.size,
    rows,
    target_tab: getTargetTab(),
  }, extra || {});
}

async function _postToSync(payload) {
  const url = getSyncUrl();
  if (!url) throw new Error("No Apps Script URL configured. Open Settings (⚙) and paste it.");
  // Stamp every request with the Google ID token so Apps Script can verify
  // identity via tokeninfo. Session.getActiveUser() doesn't work for
  // personal Gmail callers, so this is the load-bearing identity path.
  const body = Object.assign({}, payload, { id_token: state.idToken || "" });
  // text/plain is a "simple" request — no CORS preflight. The Apps Script
  // reads e.postData.contents either way.
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 240)}`);
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error("Server replied with non-JSON: " + text.slice(0, 240)); }
}

async function refreshSnapshot() {
  // Prefer the live Apps Script endpoint when a URL is configured; that
  // reads DepthCharts directly so edits made in the sheet show up
  // immediately. Falls back to fetching docs/data/snapshot.json (which is
  // only refreshed every ~10 min by the GH Action cron).
  const syncUrl = getSyncUrl();
  if (syncUrl) {
    try {
      // Sticky toast — stays visible until the request returns and we
      // replace it with a success/error message. Apps Script can take
      // 5-10 s, longer than any reasonable auto-hide.
      toast("Refreshing from sheet…", Infinity);
      const fresh = await _postToSync({ action: "snapshot", source_tab: "DepthCharts" });
      if (!fresh || !fresh.ok) {
        throw new Error((fresh && fresh.error) || "snapshot endpoint returned not-ok");
      }
      // A stale Apps Script deployment (predating handleSnapshot) will ignore
      // action="snapshot" and respond with a sync-summary that has no `depth`.
      // Catch that here so we don't blow up dereferencing it below.
      if (!fresh.depth || !Array.isArray(fresh.depth.rows)) {
        throw new Error(
          "Live snapshot endpoint not available — your Apps Script deployment " +
          "is older than sync.gs's handleSnapshot. Redeploy sync.gs " +
          "(Deploy → Manage deployments → Edit → New version)."
        );
      }
      // Merge: keep cached rosters/options/transactions, replace depth.
      state.snapshot = Object.assign({}, state.snapshot, {
        depth: fresh.depth,
        generated_at: fresh.generated_at,
        source: fresh.source,
      });
      state.rows = fresh.depth.rows.map(r => ({ ...r }));
      state.baseline = new Map(fresh.depth.rows.map(r => [r._sheet_row, { ...r }]));
      applyEditsToRows();
      setSnapshotAgeBadge(fresh.generated_at, fresh.source);
      renderTeamView();
      rebuildWarnings();
      toast(`Live refresh: ${fresh.depth.rows.length} rows from ${fresh.source_tab}.`, 3000);
      return;
    } catch (err) {
      console.warn("Live refresh failed, falling back to static snapshot:", err);
      toast("Live refresh failed; using cached snapshot. " + (err.message || err), 6000);
    }
  }
  // Static fallback.
  const snap = await fetchSnapshot();
  state.snapshot = snap;
  state.rows = snap.depth.rows.map(r => ({ ...r }));
  state.baseline = new Map(snap.depth.rows.map(r => [r._sheet_row, { ...r }]));
  applyEditsToRows();
  setSnapshotAgeBadge(snap.generated_at);
  renderTeamView();
  rebuildWarnings();
}

// Distinct non-FA teams the pending edits touch (as the rows stand now, so a
// player edited from one team to another counts under the destination team —
// same as the server's _teamsTouchedByDiff, which reads the payload's team).
function _teamsWithPendingEdits() {
  const teams = new Set();
  for (const sheetRow of state.editedRowKeys) {
    const row = state.rows.find((r) => r._sheet_row === sheetRow);
    const t = row ? (row.team || "").trim().toUpperCase() : "";
    if (t && t !== FA_TEAM) teams.add(t);
  }
  return [...teams];
}

// Sync spans however many teams the edit queue touches; grab any locks the
// caller doesn't currently hold so the server's per-team lock gate passes.
// Returns null on success, or an error message when a team is actively
// locked by someone else.
async function _ensureLocksForPendingEdits() {
  const needed = _teamsWithPendingEdits().filter((t) => !holdsLock(t));
  const blocked = [];
  for (const team of needed) {
    const lock = await acquireLock(team);
    if (!lock) {
      const other = (state.allLocks || []).find((l) => l.team === team && !l.expired);
      blocked.push(team + (other ? " (held by " + other.owner_email + ")" : ""));
    }
  }
  if (blocked.length === 0) return null;
  return "Your edits touch " + blocked.length + " team" + (blocked.length === 1 ? "" : "s") +
    " you can't lock right now: " + blocked.join(", ") +
    ". Wait for the other editor to finish (or ask them to release), then Sync again.";
}

async function onSyncToSheet() {
  if (state.edits.length === 0) {
    toast("No pending edits to sync.", 3000);
    return;
  }
  if (!getSyncUrl()) {
    openSettings(true);
    setSettingsStatus("Paste your Apps Script URL first, then try Sync again.", "error");
    return;
  }
  // Pull the live sheet first and replay edits on top of it, so the diff is
  // computed against what's actually there now. This catches sheet-side row
  // inserts/deletes (edits whose rows moved are discarded with a toast) and
  // means the preview reflects other people's changes since we loaded.
  showSyncModal({ phase: "loading", message: "Refreshing from sheet…" });
  await refreshSnapshot();
  if (state.edits.length === 0) {
    showSyncModal({
      phase: "error",
      message: "No edits left to sync — your pending edits were discarded because the sheet's rows moved since you made them. Please redo them.",
    });
    return;
  }
  // The server requires a lock per team touched; auto-acquire any we're
  // missing (a lock may have expired, or an edit moved a player to a team we
  // never locked) instead of bouncing the user to do it by hand.
  showSyncModal({ phase: "loading", message: "Checking team locks…" });
  const lockProblem = await _ensureLocksForPendingEdits();
  if (lockProblem) {
    showSyncModal({ phase: "error", message: "Sync blocked — " + lockProblem });
    return;
  }
  showSyncModal({ phase: "loading", message: "Computing dry-run preview…" });
  try {
    const preview = await _postToSync(_buildSyncPayload({ commit: false }));
    if (!preview.ok) {
      showSyncModal({
        phase: "error",
        message: formatSyncError(preview),
      });
      return;
    }
    showSyncModal({ phase: "preview", result: preview });
  } catch (err) {
    showSyncModal({ phase: "error", message: String(err.message || err) });
  }
}

function formatSyncError(resp) {
  if (!resp) return "Unknown server error.";
  if (resp.error === "missing_lock") {
    const missing = (resp.teams_missing || []).join(", ");
    const others  = (resp.teams_held_by_others || [])
      .map((h) => `${h.team} (held by ${h.owner_email})`)
      .join(", ");
    const parts = [];
    if (missing) parts.push("teams not locked by you: " + missing);
    if (others)  parts.push("teams locked by others: " + others);
    return "Sync refused — " + (parts.join("; ") || "you don't hold the right locks.") +
      " Try Sync again (it auto-locks the teams your edits touch).";
  }
  if (resp.error === "stale_snapshot") {
    const sample = (resp.sample_stale || [])
      .map((s) => `row ${s.row} (${s.team}): expected ${s.expected || "—"}, sheet has ${s.found || "blank"}`)
      .join("; ");
    return "Sync refused — the sheet's rows have moved since you loaded (" +
      (resp.stale_count || "?") + " row" + (resp.stale_count === 1 ? "" : "s") + " no longer match" +
      (sample ? ": " + sample : "") + "). Click Refresh, then redo your edits.";
  }
  if (resp.error === "sign_in_required") return "Sign-in token expired or missing. Sign out and back in.";
  if (resp.error === "not_authorized")   return "Your account (" + (resp.email || "unknown") + ") isn't on the Apps Script editor allowlist.";
  return "Server refused: " + (resp.error || "unknown");
}

async function _syncCommit() {
  showSyncModal({ phase: "loading", message: "Writing to sheet…" });
  try {
    const result = await _postToSync(_buildSyncPayload({ commit: true }));
    if (!result.ok) {
      showSyncModal({
        phase: "error",
        message: formatSyncError(result),
      });
      return;
    }
    // Sync succeeded — the sheet is now authoritative for the rows we
    // just wrote. Clear the local edit log so the row no longer shows
    // as "edited" and so a subsequent snapshot refresh doesn't re-apply
    // the same edits on top of the fresh data.
    state.edits = [];
    state.editedRowKeys.clear();
    persistEdits();
    updateEditCount();
    // Pull fresh data so newly-appended rows pick up their real sheet
    // row numbers (the local copies had virtual ids ≥ 100000).
    refreshSnapshot().catch(() => {});
    showSyncModal({ phase: "done", result });
  } catch (err) {
    showSyncModal({ phase: "error", message: String(err.message || err) });
  }
}

function showSyncModal({ phase, message, result }) {
  const scrim = document.getElementById("sync-modal-scrim");
  const title = document.getElementById("sync-modal-title");
  const body  = document.getElementById("sync-modal-body");
  const foot  = document.getElementById("sync-modal-foot");
  scrim.style.display = "flex";
  body.innerHTML = "";
  foot.innerHTML = "";

  if (phase === "loading") {
    title.textContent = "Working…";
    body.innerHTML = `<div class="loader"><div class="spinner"></div><p>${escapeHTML(message || "")}</p></div>`;
    return;
  }
  if (phase === "error") {
    title.textContent = "Sync failed";
    body.innerHTML = `<p class="sync-error">${escapeHTML(message || "Unknown error.")}</p>`;
    foot.appendChild(_modalButton("Close", "btn--ghost", closeSyncModal));
    return;
  }
  if (phase === "preview") {
    const r = result;
    title.textContent = `Preview: ${r.target_tab}`;
    body.appendChild(_renderSyncSummary(r));
    const apply = _modalButton(`Apply ${r.updates_count} updates + ${r.appends_count} new rows`, "btn--primary", _syncCommit);
    if (r.updates_count + r.appends_count === 0) apply.disabled = true;
    foot.appendChild(apply);
    foot.appendChild(_modalButton("Cancel", "btn--ghost", closeSyncModal));
    return;
  }
  if (phase === "done") {
    const r = result;
    title.textContent = `Synced to ${r.target_tab}`;
    const summary = document.createElement("p");
    summary.innerHTML = `Wrote <strong>${r.cells_written ?? 0}</strong> cells; appended <strong>${r.appended_rows ?? 0}</strong> new rows`
      + (r.appended_at_row ? ` starting at row ${r.appended_at_row}` : "")
      + (typeof r.elapsed_ms === "number" ? ` in ${r.elapsed_ms} ms` : "")
      + (r.actor_email ? ` as <code>${escapeHTML(r.actor_email)}</code>` : "")
      + ".";
    body.appendChild(summary);
    foot.appendChild(_modalButton("Done", "btn--primary", closeSyncModal));
    return;
  }
}

function closeSyncModal() {
  document.getElementById("sync-modal-scrim").style.display = "none";
}

function _renderSyncSummary(r) {
  const wrap = document.createElement("div");
  const head = document.createElement("p");
  head.innerHTML = `<strong>${r.updates_count}</strong> rows with updates &middot; <strong>${r.appends_count}</strong> new rows to append.`;
  wrap.appendChild(head);

  // Lookup by sheet row so we can surface the affected player on each change.
  const rowsByRow = new Map();
  for (const row of state.rows) {
    rowsByRow.set(Number(row._sheet_row), row);
  }

  if (r.sample_updates && r.sample_updates.length) {
    const h = document.createElement("h3"); h.textContent = "Sample updates";
    wrap.appendChild(h);
    const ul = document.createElement("ul"); ul.className = "sync-list";
    for (const u of r.sample_updates) {
      const row = rowsByRow.get(Number(u.row)) || {};
      const name    = row.displayName || "(unknown player)";
      const elias   = row.eliasId   || "—";
      const gsis    = row.gsisId    || "—";
      const team    = row.team      || "—";
      const li = document.createElement("li");
      li.className = "sync-list__row";
      li.innerHTML = `
        <div class="sync-list__player">
          <strong>${escapeHTML(name)}</strong>
          <span class="sync-list__tag">${escapeHTML(team)}</span>
          <span class="sync-list__id">elias <code>${escapeHTML(elias)}</code></span>
          <span class="sync-list__id">gsis <code>${escapeHTML(gsis)}</code></span>
        </div>
        <div class="sync-list__change">
          row <code>${u.row}</code> &middot;
          <strong>${escapeHTML(u.key)}</strong>:
          <code>${escapeHTML(u.before || "")}</code> → <code>${escapeHTML(u.after || "")}</code>
        </div>
      `;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  if (r.sample_appends && r.sample_appends.length) {
    const h = document.createElement("h3"); h.textContent = "Sample new rows";
    wrap.appendChild(h);
    const ul = document.createElement("ul"); ul.className = "sync-list";
    for (const a of r.sample_appends) {
      const li = document.createElement("li");
      li.className = "sync-list__row";
      // Find the matching in-memory row to recover gsisId (sample_appends from
      // the script only carries a subset of fields).
      const match = state.rows.find(rr =>
        (rr.displayName === a.displayName) &&
        (rr.team === a.team) &&
        (rr.depthPosition === a.depthPosition)
      ) || {};
      li.innerHTML = `
        <div class="sync-list__player">
          + <strong>${escapeHTML(a.displayName)}</strong>
          <span class="sync-list__tag">${escapeHTML(a.team)}</span>
          <span class="sync-list__tag">${escapeHTML(a.depthPosition)}</span>
        </div>
        <div class="sync-list__change">
          elias <code>${escapeHTML(a.eliasId || match.eliasId || "")}</code>
          &middot; gsis <code>${escapeHTML(match.gsisId || "")}</code>
        </div>
      `;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  if (r.note) {
    const p = document.createElement("p"); p.className = "muted"; p.textContent = r.note;
    wrap.appendChild(p);
  }
  return wrap;
}

function _modalButton(label, klass, onClick) {
  const b = document.createElement("button");
  b.className = "btn " + (klass || "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
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
        // auto_select: silent re-sign-in on repeat visits if the user has
        // already approved this app and only one Google account is signed
        // in to the browser. First visit still shows the One Tap UI below.
        auto_select: true,
        cancel_on_tap_outside: false,
      });
      google.accounts.id.renderButton(
        document.getElementById("google-signin"),
        { theme: "filled_black", size: "large", text: "signin_with" }
      );
      // One Tap: a small "Continue as X" prompt in the top-right. After the
      // first manual sign-in, returns instantly without a click (auto_select).
      // If the prompt can't be shown (blocked, multiple accounts not chosen),
      // the renderButton above remains as a fallback.
      google.accounts.id.prompt();
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
  state.idToken = resp.credential;
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

async function signOut() {
  // Best-effort: drop any locks we hold so peers aren't blocked.
  if (state.myLocks.length > 0) {
    try { await releaseAllLocks(); } catch {}
  }
  state.authedEmail = null;
  state.myLocks = [];
  state.allLocks = [];
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

function toast(msg, durationMs) {
  console.log("[toast]", msg);
  const el = document.getElementById("edit-count");
  if (el) {
    el.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }],
      { duration: 280 }
    );
  }
  // Floating bottom toast for messages that need to be readable.
  // durationMs === Infinity → sticky (stay until replaced or hideToast()).
  // durationMs > 0          → auto-hide after that many ms.
  // omitted / 0             → no floating toast at all.
  if (typeof durationMs === "number" && (durationMs > 0 || durationMs === Infinity)) {
    let tost = document.getElementById("floating-toast");
    if (!tost) {
      tost = document.createElement("div");
      tost.id = "floating-toast";
      tost.className = "floating-toast";
      document.body.appendChild(tost);
    }
    tost.textContent = msg;
    tost.classList.add("is-visible");
    clearTimeout(toast._timer);
    if (Number.isFinite(durationMs)) {
      toast._timer = setTimeout(() => tost.classList.remove("is-visible"), durationMs);
    }
  }
}

function hideToast() {
  const tost = document.getElementById("floating-toast");
  if (tost) tost.classList.remove("is-visible");
  clearTimeout(toast._timer);
}

function showFatalError(msg) {
  document.getElementById("app").innerHTML = `
    <div class="loader" style="color: var(--danger);">
      <p><strong>Fatal:</strong> ${escapeHTML(msg)}</p>
      <p class="muted">Check the browser console for details.</p>
    </div>`;
}
