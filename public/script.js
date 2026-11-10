(() => {
"use strict";

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
// 計画の既定色は青、実施は赤。赤は実施専用にしたいので、計画用の色見本には入れていない。
const PLAN_DEFAULT = "#2563eb";
const ACTUAL_COLOR = "#dc2626";
const PALETTE = [
  PLAN_DEFAULT, "#0ea5e9", "#14b8a6", "#22c55e", "#eab308",
  "#f59e0b", "#8b5cf6", "#64748b", "#1e293b"
];
const MAX_LEVEL = 2; // 大工種 → 中工種 → 小工種（作業）の3階層
const LEVEL_NAME = ["大工種", "中工種", "作業"];
const META_INPUT_ID = {
  projectName: "f-projectName", orderer: "f-orderer", location: "f-location",
  supervisor: "f-supervisor", contractor: "f-contractor",
  contractDate: "f-contractDate", createdDate: "f-createdDate",
  startDate: "f-startDate", endDate: "f-endDate"
};

/* ---------------- utils ---------------- */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, cls) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("class", "icon" + (cls ? " " + cls : ""));
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVG_NS, "use");
  u.setAttribute("href", "#i-" + name);
  s.appendChild(u);
  return s;
}

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 容量超過などは無視 */ } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

/* ---------------- date helpers ---------------- */
function pad2(n) { return String(n).padStart(2, "0"); }

function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function todayISO() { return isoDate(new Date()); }

function dateRangeArray(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  let cur = parseISO(startISO);
  const end = parseISO(endISO);
  if (isNaN(cur) || isNaN(end) || cur > end) return out;
  while (cur <= end) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function dateRangeISO(startISO, endISO) {
  return dateRangeArray(startISO, endISO).map(isoDate);
}

function diffDays(aISO, bISO) {
  return Math.round((parseISO(aISO) - parseISO(bISO)) / 86400000);
}

function formatJP(iso) {
  if (!iso) return "";
  const d = parseISO(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatShort(iso) {
  if (!iso) return "";
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function monthListBetween(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  const s = parseISO(startISO), e = parseISO(endISO);
  if (isNaN(s) || isNaN(e)) return out;
  let y = s.getFullYear(), m = s.getMonth();
  while (y < e.getFullYear() || (y === e.getFullYear() && m <= e.getMonth())) {
    out.push({ key: `${y}-${pad2(m + 1)}`, label: `${y}年${m + 1}月`, year: y, month: m + 1 });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

function uid() {
  return "id" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function plainMap(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

/* 旧バージョンで作られた項目（level / labels / actual を持たない）でも安全に扱えるよう、
   op から受け取った item は必ずここを通してから state に入れる。
   cells = 計画（日付→色）、actual = 実施（日付→1）、labels = 作業名（日付→文字）。 */
function normalizeItem(raw) {
  const it = raw && typeof raw === "object" ? raw : {};
  return {
    id: it.id || uid(),
    name: typeof it.name === "string" ? it.name : "",
    bold: !!it.bold,
    level: Math.max(0, Math.min(MAX_LEVEL, Number(it.level) || 0)),
    cells: plainMap(it.cells),
    labels: plainMap(it.labels),
    actual: plainMap(it.actual),
    done: !!it.done
  };
}

/* ---------------- default state ----------------
   実際の工事情報は新規作成フォームからサーバーに登録され、resetAll op として
   同期されてくる。ここはサーバーに繋がるまでの一時的な土台。 */
function defaultState() {
  const today = new Date();
  const monthLater = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
  const names = ["準備工", "仮設工", "土工", "構造物工", "付帯工", "後片付け工"];
  return {
    meta: {
      projectName: "",
      orderer: "",
      location: "",
      supervisor: "",
      contractor: "",
      contractDate: "",
      createdDate: isoDate(today),
      startDate: isoDate(today),
      endDate: isoDate(monthLater)
    },
    items: names.map((name) => ({ id: uid(), name, bold: true, level: 0, cells: {}, labels: {}, actual: {} })),
    progress: { plan: {}, actual: {} }
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    meta: Object.assign(base.meta, raw.meta || {}),
    items: Array.isArray(raw.items) && raw.items.length
      ? raw.items.map(normalizeItem)
      : base.items,
    progress: {
      plan: plainMap(raw.progress && raw.progress.plan),
      actual: plainMap(raw.progress && raw.progress.actual)
    }
  };
}

let state = null;

function findItem(id) { return state.items.find((i) => i.id === id); }

/* ---------------- 保存キー ----------------
   工事案件ごとに部屋を分ける。?project= が無い場合は一覧へ戻す。
   旧URL(?room=) を開いた人のために room も見る。 */
const params = new URLSearchParams(location.search);
const roomId = params.get("project") || params.get("room") || "";
const POLL_INTERVAL_MS = 2000;
const BATCH_LIMIT = 500;

/* 端末に置く控え（state）と、どこまで受信したか（lastSeq）。
   v2：実施（actual）を扱えない旧版の画面が残した控えは、実施のopを読み飛ばしている
   可能性がある。キーを変えて、新版では必ず履歴の先頭から組み立て直す。 */
const STORAGE_KEY = "koutei-hyou-state-v2:" + roomId;
const LASTSEQ_KEY = "koutei-hyou-lastseq-v2:" + roomId;
// ここから下は「見え方」の設定。opとして同期せず端末ごとに覚える
const VIEW_KEY = "koutei-hyou-view-v1:" + roomId;
const RANGE_KEY = "koutei-hyou-range-v1:" + roomId;
const COLLAPSE_KEY = "koutei-hyou-collapsed-v1:" + roomId;
const ZOOM_KEY = "koutei-hyou-zoom-v1";
const UNIFORM_KEY = "koutei-hyou-uniform-v1";
const TIP_KEY = "koutei-hyou-touch-tip-v1";

/* ---------------- realtime sync (HTTP polling against D1-backed op log) ---------------- */
let lastSeq = Number(lsGet(LASTSEQ_KEY) || "0") || 0;
const appliedSeqs = new Set();
let offlineQueue = [];
let firstPullDone = false;

function setConnStatus(status) {
  const box = $("#conn-status");
  if (!box) return;
  box.classList.remove("conn-online", "conn-offline");
  const text = box.querySelector("span");
  if (status === "online") {
    box.classList.add("conn-online");
    text.textContent = "同期中";
    box.title = "この工程表を開いている全員の編集が、数秒おきに自動で反映されます";
  } else {
    box.classList.add("conn-offline");
    text.textContent = "オフライン（端末に保存）";
    box.title = "サーバーに繋がっていません。編集はこの端末に保存され、繋がり次第送信されます";
  }
}

function saveLastSeq() { lsSet(LASTSEQ_KEY, String(lastSeq)); }

// Pulls every new op since lastSeq, applying any we haven't already applied
// (our own just-sent ops included) and advances lastSeq only from what the
// server actually confirms, so no op is ever skipped due to out-of-order seqs.
async function syncPull() {
  // 1) まず取得だけを行う。ここで失敗した時だけが本当の「オフライン」。
  let incoming = [];
  try {
    let more = true;
    let cursor = lastSeq;
    while (more) {
      const res = await fetch(`/api/ops?room=${encodeURIComponent(roomId)}&since=${cursor}`);
      if (!res.ok) throw new Error("poll failed");
      const data = await res.json();
      const ops = Array.isArray(data.ops) ? data.ops : [];
      incoming = incoming.concat(ops);
      if (ops.length) cursor = ops[ops.length - 1].seq;
      more = ops.length === BATCH_LIMIT;
    }
  } catch (e) {
    setConnStatus("offline");
    return false;
  }

  // 2) 取得できた時点で「オンライン」。以降の適用エラーで同期を止めない。
  setConnStatus("online");
  applyIncomingOps(incoming);
  return true;
}

// 受信したopをまとめて反映する。
// 1件だけなら差分描画、まとめて来た場合は状態を全部進めてから1回だけ再描画するので、
// 履歴が数百件あっても初回読み込みで固まらない。
function applyIncomingOps(list) {
  const fresh = [];
  for (const entry of list) {
    if (!entry || typeof entry.seq !== "number") continue;
    if (!appliedSeqs.has(entry.seq)) {
      appliedSeqs.add(entry.seq);
      fresh.push(entry.op);
    }
    if (entry.seq > lastSeq) lastSeq = entry.seq;
  }
  saveLastSeq();
  if (!fresh.length) return;

  if (fresh.length === 1) {
    receiveRemoteOp(fresh[0]);
    return;
  }
  for (const op of fresh) {
    try {
      applyOp(op);
    } catch (e) {
      // 壊れたop 1件のせいで同期全体が止まらないように読み飛ばす
      console.warn("同期: 適用できないopをスキップしました", op, e);
    }
  }
  renderAll();
  refreshRowSheet();
  saveLocal();
}

async function syncPush(op) {
  try {
    const res = await fetch(`/api/op?room=${encodeURIComponent(roomId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op })
    });
    if (!res.ok) throw new Error("push failed");
    const data = await res.json();
    appliedSeqs.add(data.seq); // already applied optimistically; don't re-apply when it shows up in a poll
    setConnStatus("online");
  } catch (e) {
    offlineQueue.push(op);
    setConnStatus("offline");
  }
}

async function flushOfflineQueue() {
  if (!offlineQueue.length) return;
  const queued = offlineQueue;
  offlineQueue = [];
  for (const op of queued) {
    await syncPush(op);
  }
}

async function startSync() {
  const ok = await syncPull();
  if (ok && lastSeq === 0) {
    // pull succeeded and found no history at all: this room is brand-new,
    // so seed it with our local starting state as the first op everyone replays.
    // 部屋の初期化は編集操作ではないので、閲覧のみでも必ず送る。
    sendOp({ type: "resetAll", state });
  }
  firstPullDone = true;
  autoScrollToTodayOnce();
  setInterval(async () => {
    await flushOfflineQueue();
    await syncPull();
  }, POLL_INTERVAL_MS);
}

/* ---------------- op application ---------------- */
function applyOp(op) {
  switch (op.type) {
    case "paint": {
      const item = findItem(op.itemId);
      if (item) item.cells[op.date] = op.color;
      break;
    }
    case "erase": {
      const item = findItem(op.itemId);
      if (item) {
        delete item.cells[op.date];
        delete item.labels[op.date];
      }
      break;
    }
    // 範囲をまとめて塗った時。日単位のデータに展開して持つので、
    // 保存されている工程はどのビューで編集しても日単位のまま。
    case "paintRange": {
      const item = findItem(op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) item.cells[iso] = op.color;
      }
      break;
    }
    case "eraseRange": {
      const item = findItem(op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) {
          delete item.cells[iso];
          delete item.labels[iso];
        }
      }
      break;
    }
    // 実施（下段）。計画とは別に持つので、計画のバーや作業名には触らない。
    case "paintActual": {
      const item = findItem(op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) item.actual[iso] = 1;
      }
      break;
    }
    case "eraseActual": {
      const item = findItem(op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) delete item.actual[iso];
      }
      break;
    }
    // 「元に戻す」用。日付ごとに値を直接指定する（null は消す）。
    case "setCells": {
      const item = findItem(op.itemId);
      if (!item) break;
      [["plan", item.cells], ["labels", item.labels], ["actual", item.actual]].forEach(([key, target]) => {
        const src = plainMap(op[key]);
        Object.keys(src).forEach((iso) => {
          if (src[iso] === null || src[iso] === undefined || src[iso] === "") delete target[iso];
          else target[iso] = src[iso];
        });
      });
      break;
    }
    // 完了の印。実施のバーとは別に、人が「終わった」と決めた時だけ付ける
    case "setDone": {
      const item = findItem(op.itemId);
      if (item) item.done = !!op.done;
      break;
    }
    case "setLabel": {
      const item = findItem(op.itemId);
      if (item) {
        if (op.text) item.labels[op.date] = op.text;
        else delete item.labels[op.date];
      }
      break;
    }
    case "setLevel": {
      const item = findItem(op.itemId);
      if (item) item.level = Math.max(0, Math.min(MAX_LEVEL, op.level));
      break;
    }
    case "addItem":
      state.items.push(normalizeItem(op.item));
      break;
    case "removeItem":
      state.items = state.items.filter((i) => i.id !== op.itemId);
      break;
    case "renameItem": {
      const item = findItem(op.itemId);
      if (item) item.name = op.name;
      break;
    }
    case "toggleBold": {
      const item = findItem(op.itemId);
      if (item) item.bold = !item.bold;
      break;
    }
    case "moveItem": {
      const idx = state.items.findIndex((i) => i.id === op.itemId);
      const newIdx = idx + op.dir;
      if (idx >= 0 && newIdx >= 0 && newIdx < state.items.length) {
        const [it] = state.items.splice(idx, 1);
        state.items.splice(newIdx, 0, it);
      }
      break;
    }
    // ドラッグ＆ドロップ用。toIndex は「移動後の並びでの位置」。
    case "reorderItem": {
      const idx = state.items.findIndex((i) => i.id === op.itemId);
      const to = Number(op.toIndex);
      if (idx < 0 || !Number.isFinite(to)) break;
      const [it] = state.items.splice(idx, 1);
      const dest = Math.max(0, Math.min(state.items.length, Math.round(to)));
      state.items.splice(dest, 0, it);
      break;
    }
    case "setMeta":
      state.meta[op.key] = op.value;
      break;
    case "setProgress":
      if (state.progress[op.kind]) state.progress[op.kind][op.monthKey] = op.value;
      break;
    case "resetAll":
      state = normalizeState(op.state);
      undoStack.length = 0;
      break;
  }
}

function renderForOp(op) {
  switch (op.type) {
    case "paint":
    case "erase":
    case "paintRange":
    case "eraseRange":
    case "paintActual":
    case "eraseActual":
    case "setCells":
    case "setLabel":
    case "setDone":
      renderRowTrack(op.itemId);
      break;
    case "setLevel":
    case "addItem":
    case "removeItem":
    case "moveItem":
    case "reorderItem":
      renderGantt();
      break;
    case "renameItem":
    case "toggleBold": {
      const item = findItem(op.itemId);
      const btn = document.querySelector(`.g-row[data-item-id="${cssEscape(op.itemId)}"] .row-name`);
      if (item && btn) paintRowName(btn, item);
      break;
    }
    case "setMeta": {
      if (op.key === "startDate" || op.key === "endDate") {
        renderHeader();
        renderRangeUI();
        renderGantt();
        renderProgress();
      } else {
        const id = META_INPUT_ID[op.key];
        const input = id && document.getElementById(id);
        if (input && document.activeElement !== input) input.value = state.meta[op.key] || "";
        if (op.key === "projectName") renderToolbarName();
      }
      break;
    }
    case "setProgress": {
      const input = document.querySelector(
        `#progress-table input[data-kind="${op.kind}"][data-month="${op.monthKey}"]`
      );
      if (input && document.activeElement !== input) input.value = op.value ?? "";
      renderChart();
      break;
    }
    case "resetAll":
      renderAll();
      break;
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

/* 編集opの唯一の出口。閲覧のみの時はここで止めるので、
   画面側の無効化を1か所取りこぼしても勝手に上書きされることはない。 */
function dispatchLocal(op) {
  if (!editMode) return false;
  sendOp(op);
  return true;
}

// 部屋の初期化など、編集モードとは無関係に送る必要があるop用
function sendOp(op) {
  applyOp(op);
  renderForOp(op);
  refreshRowSheet();
  saveLocal();
  syncPush(op);
}

function receiveRemoteOp(op) {
  try {
    applyOp(op);
    renderForOp(op);
  } catch (e) {
    console.warn("同期: opの反映に失敗したため全体を再描画します", op, e);
    try { renderAll(); } catch (e2) { /* ここまで来たら描画は諦める */ }
  }
  refreshRowSheet();
  saveLocal();
}

/* ---------------- persistence (local cache / offline fallback) ---------------- */
function saveLocal() { lsSet(STORAGE_KEY, JSON.stringify(state)); }

function loadLocal() {
  try {
    const raw = lsGet(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ---------------- 通知・シート ---------------- */
let toastTimer = null;
function showToast(msg) {
  const wrap = $("#toast-wrap");
  if (!wrap) return;
  wrap.textContent = "";
  wrap.appendChild(el("div", "toast", msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { wrap.textContent = ""; }, 2800);
}

let openSheetId = null;

function openSheet(id) {
  $$("#backdrop .sheet").forEach((s) => { s.hidden = s.id !== id; });
  $("#backdrop").hidden = false;
  openSheetId = id;
}

function closeSheet() {
  if (!openSheetId) return;
  if (openSheetId === "sheet-row") commitRowName();
  const active = document.activeElement;
  if (active && active.blur && $("#backdrop").contains(active)) active.blur();
  $("#backdrop").hidden = true;
  $$("#backdrop .sheet").forEach((s) => { s.hidden = true; });
  if (openSheetId === "sheet-row") rowSheetId = null;
  openSheetId = null;
}

function bindSheets() {
  const backdrop = $("#backdrop");
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest("[data-close]")) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openSheetId) { e.preventDefault(); closeSheet(); }
  });
}

/* ---------------- タブ（工程表／出来高／工事情報） ---------------- */
let currentTab = "gantt";

function setTab(name) {
  currentTab = name;
  ["gantt", "progress", "info"].forEach((t) => {
    $("#page-" + t).hidden = t !== name;
    document.body.classList.toggle("tab-" + t, t === name);
  });
  $$(".tab").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (name === "progress") requestAnimationFrame(renderChart);
}

function bindTabs() {
  $$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  setTab("gantt");
}

/* ---------------- 工事情報 ---------------- */
function renderHeader() {
  const m = state.meta;
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    const input = document.getElementById(id);
    if (!input) return;
    if (document.activeElement !== input) input.value = m[key] || "";
    // 日付欄は readonly でもカレンダーから変えられてしまう環境があるので disabled にする
    if (input.type === "date") input.disabled = !editMode;
    else input.readOnly = !editMode;
  });
  const note = $("#info-note");
  if (note) note.hidden = editMode;
  renderToolbarName();
}

function renderToolbarName() {
  const name = state.meta.projectName || "工事工程表";
  $("#toolbar-project-name").textContent = name;
  document.title = name + " | 工事工程表";
}

function bindHeaderEvents() {
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    document.getElementById(id).addEventListener("change", (e) => {
      const value = e.target.value;
      // 工期を空や逆順にすると表が消えてしまうので、ここで止める
      if ((key === "startDate" || key === "endDate")) {
        const start = key === "startDate" ? value : state.meta.startDate;
        const end = key === "endDate" ? value : state.meta.endDate;
        if (!value || (start && end && start > end)) {
          showToast("工期は「開始日 ≦ 終了日」になるように入力してください");
          e.target.value = state.meta[key] || "";
          return;
        }
      }
      dispatchLocal({ type: "setMeta", key, value });
    });
  });
}

/* ---------------- 編集モード ----------------
   既定は「閲覧のみ」。編集ボタンを押している間だけ書き換えられる。
   ページを開き直すと必ず閲覧のみに戻る（意図しない上書きを防ぐのが目的なので、
   この状態はあえて保存しない）。 */
let editMode = false;

function setEditMode(on) {
  editMode = !!on;
  document.body.classList.toggle("edit-mode", editMode);
  cancelPaintDrag();
  renderEditModeUI();
  renderHeader();
  renderProgress();
  refreshRowSheet();
  if (editMode) maybeShowTouchTip();
}

function renderEditModeUI() {
  const btn = $("#btn-edit-mode");
  btn.textContent = "";
  btn.appendChild(icon(editMode ? "check" : "edit", "icon-sm"));
  btn.appendChild(el("span", "", editMode ? "完了" : "編集"));
  btn.title = editMode ? "編集を終了して、閲覧のみに戻す" : "工程表を編集できるようにする";
  btn.setAttribute("aria-pressed", editMode ? "true" : "false");
  $("#btn-import").disabled = !editMode;
  renderUndoButton();
}

function bindEditMode() {
  $("#btn-edit-mode").addEventListener("click", () => setEditMode(!editMode));
  renderEditModeUI();
}

/* ---------------- 編集ツール ----------------
   lane = どちらの段に入力するか（計画／実施）、tool = 何をするか。 */
let lane = "plan";
let tool = "paint"; // paint | erase | label | hand
let planColor = PLAN_DEFAULT;
let paletteOpen = false;

function setLane(next) {
  lane = next === "actual" ? "actual" : "plan";
  $$(".lane-btn").forEach((b) => b.classList.toggle("selected", b.dataset.lane === lane));
  renderDockColors();
}

function setTool(next) {
  tool = next;
  $$(".tool-btn[data-tool]").forEach((b) => b.classList.toggle("selected", b.dataset.tool === tool));
  document.body.classList.toggle("tool-hand", tool === "hand");
  document.body.classList.toggle("tool-label", tool === "label");
  cancelPaintDrag();
}

function setPlanColor(color) {
  planColor = color;
  renderDockColors();
}

function renderDockColors() {
  const colorBtn = $("#btn-color");
  const dot = $("#color-dot");
  const isPlan = lane === "plan";
  dot.style.background = isPlan ? planColor : ACTUAL_COLOR;
  colorBtn.disabled = !isPlan;
  colorBtn.title = isPlan ? "計画のバーの色を選ぶ" : "実施は赤で固定です";
  colorBtn.classList.toggle("selected", isPlan && paletteOpen);
  $("#dock-colors").hidden = !(isPlan && paletteOpen);
  $$("#palette .swatch").forEach((s) => s.classList.toggle("selected", s.dataset.color === planColor));
  const custom = $("#custom-color");
  if (/^#[0-9a-f]{6}$/i.test(planColor)) custom.value = planColor;
  $("#dock-note").textContent = uniformPlan ? "「計画を青で統一」がオンの間、画面上は青で表示されます" : "";
}

function renderPalette() {
  const box = $("#palette");
  box.textContent = "";
  PALETTE.forEach((color) => {
    const btn = el("button", "swatch");
    btn.type = "button";
    btn.dataset.color = color;
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => setPlanColor(color));
    box.appendChild(btn);
  });
}

function maybeShowTouchTip() {
  const tip = $("#dock-tip");
  if (!tip) return;
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  tip.hidden = !coarse || lsGet(TIP_KEY) === "1";
}

function bindDock() {
  $$(".lane-btn").forEach((b) => b.addEventListener("click", () => setLane(b.dataset.lane)));
  $$(".tool-btn[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#btn-color").addEventListener("click", () => {
    paletteOpen = !paletteOpen;
    renderDockColors();
  });
  $("#custom-color").addEventListener("input", (e) => setPlanColor(e.target.value));
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-add-item").addEventListener("click", () => addItem(null));
  $("#btn-add-item-bottom").addEventListener("click", () => addItem(null));
  $("#dock-tip-close").addEventListener("click", () => {
    lsSet(TIP_KEY, "1");
    $("#dock-tip").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (!editMode || openSheetId) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  });
  renderPalette();
  setLane("plan");
  setTool("paint");
}

/* ---------------- 元に戻す ----------------
   バーや作業名を書き換える直前の値を控えておき、setCells op で書き戻す。
   行の追加・削除・並べ替えは対象外（確認ダイアログや上下ボタンで戻せるため）。 */
const undoStack = [];
const UNDO_LIMIT = 50;

function pickDays(map, days) {
  const out = {};
  days.forEach((iso) => { out[iso] = map[iso] === undefined ? null : map[iso]; });
  return out;
}

function pushUndo(snap) {
  undoStack.push(snap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  renderUndoButton();
}

function undo() {
  if (!editMode) return;
  while (undoStack.length) {
    const snap = undoStack.pop();
    if (!findItem(snap.itemId)) continue; // 行ごと消えていたら次へ
    dispatchLocal(Object.assign({ type: "setCells" }, snap));
    showToast("元に戻しました");
    break;
  }
  renderUndoButton();
}

function renderUndoButton() {
  const btn = $("#btn-undo");
  if (btn) btn.disabled = !editMode || !undoStack.length;
}

/* バーを引く／消す操作の本体。なぞって塗る時も、日付を指定して塗る時もここを通る。 */
function applyRange(itemId, targetLane, from, to, erase) {
  const item = findItem(itemId);
  if (!item || !from || !to) return false;
  if (from > to) { const swap = from; from = to; to = swap; }
  const days = dateRangeISO(from, to);
  if (!days.length) return false;

  const snap = { itemId };
  let op;
  if (targetLane === "actual") {
    if (erase) {
      if (!days.some((d) => item.actual[d])) return false;
      op = { type: "eraseActual", itemId, from, to };
    } else {
      if (days.every((d) => item.actual[d])) return false;
      op = { type: "paintActual", itemId, from, to };
    }
    snap.actual = pickDays(item.actual, days);
  } else if (erase) {
    if (!days.some((d) => item.cells[d] !== undefined || item.labels[d] !== undefined)) return false;
    snap.plan = pickDays(item.cells, days);
    snap.labels = pickDays(item.labels, days);
    op = days.length === 1
      ? { type: "erase", itemId, date: from }
      : { type: "eraseRange", itemId, from, to };
  } else {
    if (days.every((d) => item.cells[d] === planColor)) return false;
    snap.plan = pickDays(item.cells, days);
    op = days.length === 1
      ? { type: "paint", itemId, date: from, color: planColor }
      : { type: "paintRange", itemId, from, to, color: planColor };
  }

  if (!dispatchLocal(op)) return false;
  pushUndo(snap);
  return true;
}

/* ---------------- 表示単位（日別／週間／月間）と拡大率 ----------------
   セルのデータは日単位のまま。週間・月間ビューは日データを束ねて見せるだけなので、
   ビューを切り替えても保存されている工程は変わらない。 */
const VIEW_MODES = ["day", "week", "month"];
const COL_W = { day: [18, 28, 40], week: [40, 56, 76], month: [64, 88, 120] };
let viewMode = VIEW_MODES.includes(lsGet(VIEW_KEY)) ? lsGet(VIEW_KEY) : "day";
let zoomIdx = [0, 1, 2].includes(Number(lsGet(ZOOM_KEY))) && lsGet(ZOOM_KEY) !== null ? Number(lsGet(ZOOM_KEY)) : 1;
let uniformPlan = lsGet(UNIFORM_KEY) === "1";

function setViewMode(mode) {
  if (!VIEW_MODES.includes(mode) || mode === viewMode) return;
  const anchor = centerDateOfView();
  viewMode = mode;
  lsSet(VIEW_KEY, mode);
  renderViewSwitch();
  renderGantt();
  scrollToDate(anchor, false);
}

function setZoom(idx) {
  idx = Math.max(0, Math.min(2, idx));
  if (idx === zoomIdx) return;
  const anchor = centerDateOfView();
  zoomIdx = idx;
  lsSet(ZOOM_KEY, String(idx));
  renderViewSwitch();
  renderGantt();
  scrollToDate(anchor, false);
}

function renderViewSwitch() {
  $$(".view-btn").forEach((btn) => btn.classList.toggle("selected", btn.dataset.view === viewMode));
  $("#btn-zoom-out").disabled = zoomIdx === 0;
  $("#btn-zoom-in").disabled = zoomIdx === 2;
}

function bindViewSwitch() {
  $$(".view-btn").forEach((btn) => btn.addEventListener("click", () => setViewMode(btn.dataset.view)));
  $("#btn-zoom-out").addEventListener("click", () => setZoom(zoomIdx - 1));
  $("#btn-zoom-in").addEventListener("click", () => setZoom(zoomIdx + 1));
  $("#btn-today").addEventListener("click", () => {
    if (!scrollToDate(todayISO(), true)) showToast("今日は表示している期間の外です");
  });
  $("#btn-view-settings").addEventListener("click", () => {
    renderRangeUI();
    openSheet("sheet-view");
  });
  const uni = $("#opt-uniform");
  uni.checked = uniformPlan;
  uni.addEventListener("change", () => {
    uniformPlan = uni.checked;
    lsSet(UNIFORM_KEY, uniformPlan ? "1" : "0");
    renderGantt();
    renderDockColors();
  });
  renderViewSwitch();
}

/* ---------------- 表示期間の絞り込み ----------------
   「9月だけ」「9/1〜9/15だけ」のように、工期の一部を取り出して表示・印刷する。
   絞り込んでも工程データには一切触らないので、全期間に戻せば元通り。 */
let viewRange = loadViewRange();

function loadViewRange() {
  try {
    const raw = lsGet(RANGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (r && typeof r.from === "string" && typeof r.to === "string") return r;
  } catch (e) { /* ignore */ }
  return null;
}

function saveViewRange() {
  if (viewRange) lsSet(RANGE_KEY, JSON.stringify(viewRange));
  else lsDel(RANGE_KEY);
}

function setViewRange(from, to) {
  if (!from || !to) return;
  if (from > to) { const swap = from; from = to; to = swap; }
  viewRange = { from, to };
  saveViewRange();
  renderRangeUI();
  renderGantt();
}

function clearViewRange() {
  if (!viewRange) return;
  viewRange = null;
  saveViewRange();
  renderRangeUI();
  renderGantt();
}

// 実際に表示する期間。指定が工期からはみ出していても工期の中に収める。
function effectiveRange() {
  const from = state.meta.startDate || "";
  const to = state.meta.endDate || "";
  if (!viewRange) return { from, to };
  return {
    from: viewRange.from > from ? viewRange.from : from,
    to: viewRange.to < to ? viewRange.to : to
  };
}

// 指定期間がちょうど1ヶ月ぶんなら、その月のキーを返す（月プルダウンの選択状態用）
function wholeMonthKey(r) {
  if (!r) return "";
  const d = parseISO(r.from);
  if (d.getDate() !== 1) return "";
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12, 0, 0);
  return r.to === isoDate(last) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` : "";
}

function renderRangeUI() {
  const fromEl = $("#range-from");
  const toEl = $("#range-to");
  const r = effectiveRange();
  if (document.activeElement !== fromEl) fromEl.value = viewRange ? viewRange.from : (state.meta.startDate || "");
  if (document.activeElement !== toEl) toEl.value = viewRange ? viewRange.to : (state.meta.endDate || "");

  const sel = $("#range-month");
  if (document.activeElement !== sel) {
    const want = wholeMonthKey(viewRange);
    sel.textContent = "";
    const head = el("option", "", "全期間");
    head.value = "";
    sel.appendChild(head);
    monthListBetween(state.meta.startDate, state.meta.endDate).forEach((mo) => {
      const o = el("option", "", mo.label);
      o.value = mo.key;
      sel.appendChild(o);
    });
    sel.value = Array.from(sel.options).some((o) => o.value === want) ? want : "";
  }

  const active = !!viewRange;
  $("#range-clear").disabled = !active;
  $("#btn-view-settings").classList.toggle("btn-primary", active);

  const caption = $("#range-caption");
  const text = $("#range-caption-text");
  if (!active) {
    caption.hidden = true;
    return;
  }
  const shown = dateRangeArray(r.from, r.to).length;
  const total = dateRangeArray(state.meta.startDate, state.meta.endDate).length;
  caption.hidden = false;
  caption.classList.toggle("warn", !shown);
  text.textContent = shown
    ? `${formatJP(r.from)} 〜 ${formatJP(r.to)} を表示中（全${total}日のうち${shown}日）`
    : `指定した期間（${formatJP(viewRange.from)}〜${formatJP(viewRange.to)}）は工期の外です`;
}

function bindRangeFilter() {
  const fromEl = $("#range-from");
  const toEl = $("#range-to");
  const applyNow = () => {
    if (!fromEl.value || !toEl.value) return;
    setViewRange(fromEl.value, toEl.value);
  };
  [fromEl, toEl].forEach((input) => input.addEventListener("change", applyNow));

  const sel = $("#range-month");
  sel.addEventListener("change", () => {
    if (!sel.value) { clearViewRange(); return; }
    const [y, m] = sel.value.split("-").map(Number);
    setViewRange(
      isoDate(new Date(y, m - 1, 1, 12, 0, 0)),
      isoDate(new Date(y, m, 0, 12, 0, 0))
    );
  });

  $("#range-clear").addEventListener("click", clearViewRange);
  $("#range-clear-chip").addEventListener("click", clearViewRange);
}

/* 1列ぶんの情報を作る。days にはその列がまとめている日（表示期間内のみ）が入る。
   groupKey が同じ列は、ヘッダの1段目でひとまとめにされる。 */
function buildColumns() {
  const r = effectiveRange();
  const days = dateRangeArray(r.from, r.to);
  if (viewMode === "week") return weekColumns(days);
  if (viewMode === "month") return monthColumns(days);
  return dayColumns(days);
}

function weekendClass(d) {
  if (d.getDay() === 6) return "sat";
  if (d.getDay() === 0) return "sun";
  return "";
}

function dayColumns(days) {
  return days.map((d) => ({
    key: isoDate(d),
    days: [isoDate(d)],
    groupKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    groupLabel: `${d.getFullYear()}年${d.getMonth() + 1}月`,
    top: String(d.getDate()),
    bottom: WEEKDAY_JP[d.getDay()],
    cls: weekendClass(d)
  }));
}

// 月曜はじまりの週で束ねる。工期の最初と最後の週は途中から／途中までになる。
function weekColumns(days) {
  const cols = [];
  let cur = null;
  days.forEach((d) => {
    const monday = new Date(d);
    monday.setDate(monday.getDate() - ((d.getDay() + 6) % 7));
    const key = isoDate(monday);
    if (!cur || cur.key !== key) {
      cur = {
        key,
        days: [],
        groupKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
        groupLabel: `${d.getFullYear()}年${d.getMonth() + 1}月`,
        top: String(d.getDate()),
        bottom: "",
        cls: "",
        firstMonth: d.getMonth()
      };
      cols.push(cur);
    }
    cur.days.push(isoDate(d));
    cur.lastDate = d;
  });
  cols.forEach((c) => {
    // 月をまたぐ週は、終わりの日付に月を付けて分かるようにする
    c.bottom = c.lastDate.getMonth() === c.firstMonth
      ? `〜${c.lastDate.getDate()}`
      : `〜${c.lastDate.getMonth() + 1}/${c.lastDate.getDate()}`;
  });
  return cols;
}

function monthColumns(days) {
  const cols = [];
  let cur = null;
  days.forEach((d) => {
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    if (!cur || cur.key !== key) {
      cur = {
        key,
        days: [],
        groupKey: String(d.getFullYear()),
        groupLabel: `${d.getFullYear()}年`,
        top: `${d.getMonth() + 1}月`,
        bottom: "",
        cls: ""
      };
      cols.push(cur);
    }
    cur.days.push(isoDate(d));
  });
  // 工期の初月・末月は途中から始まる／終わるので、実際に含む日数を出す
  cols.forEach((c) => { c.bottom = `${c.days.length}日間`; });
  return cols;
}

/* ---------------- 階層の折りたたみ ---------------- */
let collapsedIds = loadCollapsed();

function loadCollapsed() {
  try {
    const raw = lsGet(COLLAPSE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}

function saveCollapsed() { lsSet(COLLAPSE_KEY, JSON.stringify([...collapsedIds])); }

function itemLevel(item) {
  return Math.max(0, Math.min(MAX_LEVEL, Number(item.level) || 0));
}

/* 工種の並びを上から見て、各行の階層・子の有無・折りたたみで隠れているかを判定する。
   「子」は、自分より下にあって自分より深い階層が続いている間の行。 */
function outlineRows() {
  const items = state.items;
  const rows = items.map((item, i) => {
    const level = itemLevel(item);
    const next = items[i + 1];
    return {
      item,
      level,
      hasChildren: !!next && itemLevel(next) > level,
      collapsed: false,
      hidden: false
    };
  });

  rows.forEach((row, i) => {
    row.collapsed = row.hasChildren && collapsedIds.has(row.item.id);
    if (!row.collapsed) return;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].level <= row.level) break;
      rows[j].hidden = true;
    }
  });

  return rows;
}

function visibleRows() {
  return outlineRows().filter((r) => !r.hidden);
}

function toggleCollapse(id) {
  if (collapsedIds.has(id)) collapsedIds.delete(id);
  else collapsedIds.add(id);
  saveCollapsed();
  renderGantt();
}

/* ---------------- 工程表の描画 ----------------
   日付のマス目は1つずつ要素を作らず、背景の模様として描く。
   行の中に置くのは「バー」と「作業名」だけなので、工期が2年近くあってもスマホで軽く動く。 */
let colList = [];
let colW = 28;
let dayOrder = [];          // 表示中の全日付 [{ iso, x, w, ci }]（x は行の左端からの位置）
let dayPos = new Map();     // iso → dayOrder の要素

function buildDayPositions() {
  dayOrder = [];
  dayPos = new Map();
  colList.forEach((col, ci) => {
    const n = col.days.length;
    col.days.forEach((iso, k) => {
      const d = { iso, x: (ci + k / n) * colW, w: colW / n, ci };
      dayOrder.push(d);
      dayPos.set(iso, d);
    });
  });
}

function planColorOf(value) {
  if (!value) return null;
  return uniformPlan ? PLAN_DEFAULT : value;
}

// 連続している同じ色の日をつないで、1本のバーにまとめる
function buildBars(colorAt) {
  const out = [];
  let cur = null;
  for (const d of dayOrder) {
    const color = colorAt(d.iso);
    if (!color) { cur = null; continue; }
    if (cur && cur.color === color && Math.abs(cur.x + cur.w - d.x) < 0.01) {
      cur.w += d.w;
    } else {
      cur = { x: d.x, w: d.w, color };
      out.push(cur);
    }
  }
  return out;
}

function fillTrack(track, item) {
  track.textContent = "";
  const frag = document.createDocumentFragment();

  buildBars((iso) => planColorOf(item.cells[iso])).forEach((b) => {
    const bar = el("div", "bar plan");
    bar.style.left = b.x.toFixed(2) + "px";
    bar.style.width = Math.max(2, b.w - 1).toFixed(2) + "px";
    bar.style.background = b.color;
    frag.appendChild(bar);
  });

  buildBars((iso) => (item.actual[iso] ? ACTUAL_COLOR : null)).forEach((b) => {
    const bar = el("div", "bar actual");
    bar.style.left = b.x.toFixed(2) + "px";
    bar.style.width = Math.max(2, b.w - 1).toFixed(2) + "px";
    frag.appendChild(bar);
  });

  // 作業名。週間・月間ビューでは、1列につき最初の1つだけ出す（重なって読めなくなるため）
  const usedCols = new Set();
  Object.keys(item.labels).sort().forEach((iso) => {
    const text = item.labels[iso];
    const pos = dayPos.get(iso);
    if (!text || !pos) return;
    if (viewMode !== "day") {
      if (usedCols.has(pos.ci)) return;
      usedCols.add(pos.ci);
    }
    const span = el("span", "bar-label", text);
    span.style.left = pos.x.toFixed(2) + "px";
    frag.appendChild(span);
  });

  track.appendChild(frag);
}

function renderRowTrack(itemId) {
  const item = findItem(itemId);
  const rowEl = document.querySelector(`.g-row[data-item-id="${cssEscape(itemId)}"]`);
  if (!item || !rowEl) return;
  fillTrack(rowEl.querySelector(".g-track"), item);
  paintRowTag(rowEl.querySelector(".row-tag"), item);
}

/* 工種の状態タグ。
   完了＝「完了にする」を押した行。未着手＝計画のバーはあるが、実施がまだ1日も無い行。
   その間（実施が入り始めて、まだ完了にしていない行）はタグを出さない。 */
const STATUS_LABEL = { done: "完了", todo: "未着手" };

function itemStatus(item) {
  if (item.done) return "done";
  const hasActual = Object.keys(item.actual).some((k) => item.actual[k]);
  const hasPlan = Object.keys(item.cells).length > 0;
  return !hasActual && hasPlan ? "todo" : "";
}

function paintRowTag(tag, item) {
  if (!tag) return;
  const st = itemStatus(item);
  tag.className = "row-tag" + (st ? " " + st : "");
  tag.textContent = STATUS_LABEL[st] || "";
  tag.hidden = !st;
}

function paintRowName(btn, item) {
  btn.textContent = item.name || "（名称なし）";
  btn.classList.toggle("bold", !!item.bold);
  btn.classList.toggle("placeholder", !item.name);
}

function renderGantt() {
  const sc = $("#gantt");
  const keepLeft = sc.scrollLeft;
  const keepTop = sc.scrollTop;

  colList = buildColumns();
  colW = COL_W[viewMode][zoomIdx];
  buildDayPositions();
  const trackW = colList.length * colW;

  sc.dataset.view = viewMode;
  sc.className = "gantt zoom-" + zoomIdx;
  sc.style.setProperty("--col-w", colW + "px");

  renderGanttHead(trackW);
  renderBackdrop(trackW);

  const rowsBox = $("#g-rows");
  rowsBox.textContent = "";
  const frag = document.createDocumentFragment();
  const rows = visibleRows();
  rows.forEach((row) => frag.appendChild(buildItemRow(row, trackW)));
  rowsBox.appendChild(frag);

  if (!colList.length) {
    rowsBox.appendChild(el("div", "gantt-empty", "表示できる期間がありません。工事情報の工期か、表示設定の期間を確認してください。"));
  }

  sc.scrollLeft = keepLeft;
  sc.scrollTop = keepTop;
}

function renderGanttHead(trackW) {
  const head = $("#g-head");
  head.textContent = "";
  head.appendChild(el("div", "g-corner", "工種"));

  const timeline = el("div", "g-timeline");
  timeline.style.width = trackW + "px";
  const months = el("div", "g-months");
  const days = el("div", "g-days");
  const today = todayISO();

  let i = 0;
  while (i < colList.length) {
    const key = colList[i].groupKey;
    let span = 0;
    while (i + span < colList.length && colList[i + span].groupKey === key) span++;
    const m = el("div", "g-month");
    m.style.width = (span * colW) + "px";
    m.appendChild(el("span", "", colList[i].groupLabel));
    months.appendChild(m);
    i += span;
  }

  colList.forEach((col) => {
    const isToday = col.days.includes(today);
    const d = el("div", "g-day" + (col.cls ? " " + col.cls : "") + (isToday ? " today" : ""));
    d.appendChild(document.createTextNode(col.top));
    d.appendChild(el("small", "", col.bottom));
    days.appendChild(d);
  });

  timeline.appendChild(months);
  timeline.appendChild(days);
  head.appendChild(timeline);
}

function renderBackdrop(trackW) {
  const back = $("#g-backdrop");
  back.textContent = "";
  back.style.width = trackW + "px";

  // 土日の色は「月曜はじまりの7日周期」の背景で描くので、初日の曜日ぶんだけずらす
  if (viewMode === "day" && colList.length) {
    const first = parseISO(colList[0].days[0]);
    const fromMonday = (first.getDay() + 6) % 7;
    back.style.setProperty("--week-off", (-fromMonday * colW) + "px");
  }

  let i = 0;
  while (i < colList.length) {
    const key = colList[i].groupKey;
    let span = 0;
    while (i + span < colList.length && colList[i + span].groupKey === key) span++;
    if (i > 0) {
      const line = el("div", "g-monthline");
      line.style.left = (i * colW) + "px";
      back.appendChild(line);
    }
    i += span;
  }

  const body = $("#g-body");
  const old = body.querySelector(".g-today");
  if (old) old.remove();
  const pos = dayPos.get(todayISO());
  if (pos) {
    const line = el("div", "g-today");
    line.style.left = `calc(var(--label-w) + ${(pos.x + pos.w / 2).toFixed(2)}px)`;
    body.appendChild(line);
  }
}

function buildItemRow(row, trackW) {
  const item = row.item;
  const r = el("div", "g-row" + (row.collapsed ? " collapsed" : ""));
  r.dataset.itemId = item.id;

  const label = el("div", "g-label lv" + row.level);

  const drag = el("span", "row-drag");
  drag.title = "ドラッグで並べ替え";
  drag.appendChild(icon("grip", "icon-fill"));
  drag.addEventListener("pointerdown", (e) => startRowDrag(e, item.id, r));

  // 折りたたみは見え方の操作なので、閲覧のみモードでも押せるようにしておく
  const twisty = el("button", "row-twisty" + (row.hasChildren ? (row.collapsed ? "" : " open") : " empty"));
  twisty.type = "button";
  twisty.appendChild(icon("chev"));
  if (row.hasChildren) {
    twisty.title = row.collapsed ? "この工種の中を表示する" : "この工種の中を折りたたむ（印刷にも出なくなります）";
    twisty.setAttribute("aria-label", twisty.title);
    twisty.addEventListener("click", () => toggleCollapse(item.id));
  } else {
    twisty.tabIndex = -1;
    twisty.setAttribute("aria-hidden", "true");
  }

  const name = el("button", "row-name");
  name.type = "button";
  name.style.paddingLeft = (2 + row.level * 10) + "px";
  paintRowName(name, item);
  name.addEventListener("click", () => openRowSheet(item.id, false));

  const more = el("button", "row-more");
  more.type = "button";
  more.title = "この行の操作";
  more.setAttribute("aria-label", "この行の操作");
  more.appendChild(icon("more", "icon-fill icon-sm"));
  more.addEventListener("click", () => openRowSheet(item.id, false));

  label.appendChild(drag);
  label.appendChild(twisty);
  label.appendChild(name);
  const tag = el("span", "row-tag");
  paintRowTag(tag, item);
  label.appendChild(tag);
  label.appendChild(more);
  r.appendChild(label);

  const track = el("div", "g-track");
  track.style.width = trackW + "px";
  fillTrack(track, item);
  r.appendChild(track);

  return r;
}

/* ---------------- 位置合わせ（今日へ移動など） ---------------- */
function labelWidth() {
  const corner = document.querySelector(".g-corner");
  return corner ? corner.offsetWidth : 0;
}

// その日が画面の中央あたりに来るように横スクロールする。表示期間の外なら false。
function scrollToDate(iso, smooth) {
  const pos = iso && dayPos.get(iso);
  if (!pos) return false;
  const sc = $("#gantt");
  const visibleW = sc.clientWidth - labelWidth();
  const left = Math.max(0, pos.x + pos.w / 2 - visibleW / 2);
  if (smooth && sc.scrollTo) sc.scrollTo({ left, behavior: "smooth" });
  else sc.scrollLeft = left;
  return true;
}

// 今、画面の中央に見えている日（表示単位や拡大率を変えても同じ場所を見続けるため）
function centerDateOfView() {
  if (!dayOrder.length) return null;
  const sc = $("#gantt");
  const x = sc.scrollLeft + (sc.clientWidth - labelWidth()) / 2;
  let best = dayOrder[0];
  for (const d of dayOrder) {
    if (d.x <= x) best = d;
    else break;
  }
  return best.iso;
}

// 開いた直後に1回だけ、今日の位置まで自動で送る（工期が長いと初日から探すのが大変なため）
let autoScrolled = false;
function autoScrollToTodayOnce() {
  if (autoScrolled) return;
  if (scrollToDate(todayISO(), false)) autoScrolled = true;
  else if (firstPullDone) autoScrolled = true;
}

/* ---------------- なぞって塗る ----------------
   マウス・ペン：押した瞬間から範囲選択。
   指：縦に動かせばスクロール、横に動かせば塗り（CSSの touch-action と組で成立する）。
   動かしている間は点線の枠で範囲を見せ、指を離した時に1回のopとして確定する。 */
let paintDrag = null;
let autoScrollRaf = 0;

function colFromClientX(track, clientX) {
  const rect = track.getBoundingClientRect();
  const i = Math.floor((clientX - rect.left) / colW);
  return Math.max(0, Math.min(colList.length - 1, i));
}

function onTrackPointerDown(e) {
  if (!editMode || tool === "hand" || paintDrag || !colList.length) return;
  const track = e.target.closest(".g-track");
  if (!track) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const row = track.parentElement;
  const isTouch = e.pointerType === "touch";
  const col = colFromClientX(track, e.clientX);

  paintDrag = {
    pointerId: e.pointerId,
    itemId: row.dataset.itemId,
    track,
    startCol: col,
    curCol: col,
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    moved: false,
    active: !isTouch && tool !== "label",
    ghost: null
  };
  if (!isTouch) e.preventDefault(); // 文字選択やドラッグ開始を防ぐ

  window.addEventListener("pointermove", onPaintPointerMove);
  window.addEventListener("pointerup", onPaintPointerUp);
  window.addEventListener("pointercancel", onPaintPointerCancel);
  if (paintDrag.active) updateGhost();
}

function onPaintPointerMove(e) {
  const d = paintDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) d.moved = true;
  if (tool === "label") return;

  if (!d.active) {
    // 指の場合：はっきり横に動いた時だけ塗り始める
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) d.active = true;
    else return;
  }
  d.lastX = e.clientX;
  d.curCol = colFromClientX(d.track, e.clientX);
  updateGhost();
  runEdgeAutoScroll();
}

function updateGhost() {
  const d = paintDrag;
  if (!d) return;
  if (!d.ghost) {
    d.ghost = el("div", "ghost" + (tool === "erase" ? " erase" : lane === "actual" ? " actual" : ""));
    d.track.appendChild(d.ghost);
  }
  const a = Math.min(d.startCol, d.curCol);
  const b = Math.max(d.startCol, d.curCol);
  d.ghost.style.left = (a * colW) + "px";
  d.ghost.style.width = ((b - a + 1) * colW) + "px";
}

// 画面の端までなぞったら、そのまま横に送る
function runEdgeAutoScroll() {
  if (autoScrollRaf) return;
  const step = () => {
    autoScrollRaf = 0;
    const d = paintDrag;
    if (!d || !d.active) return;
    const sc = $("#gantt");
    const rect = sc.getBoundingClientRect();
    const leftEdge = rect.left + labelWidth() + 28;
    const rightEdge = rect.right - 28;
    let dir = 0;
    if (d.lastX > rightEdge) dir = 1;
    else if (d.lastX < leftEdge) dir = -1;
    if (!dir) return;
    const before = sc.scrollLeft;
    sc.scrollLeft += dir * 14;
    if (sc.scrollLeft === before) return;
    d.curCol = colFromClientX(d.track, d.lastX);
    updateGhost();
    autoScrollRaf = requestAnimationFrame(step);
  };
  autoScrollRaf = requestAnimationFrame(step);
}

function endPaintDrag() {
  window.removeEventListener("pointermove", onPaintPointerMove);
  window.removeEventListener("pointerup", onPaintPointerUp);
  window.removeEventListener("pointercancel", onPaintPointerCancel);
  if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; }
  const d = paintDrag;
  paintDrag = null;
  if (d && d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
  return d;
}

function cancelPaintDrag() { if (paintDrag) endPaintDrag(); }

function onPaintPointerCancel(e) {
  if (paintDrag && e.pointerId === paintDrag.pointerId) endPaintDrag();
}

function onPaintPointerUp(e) {
  if (!paintDrag || e.pointerId !== paintDrag.pointerId) return;
  const d = endPaintDrag();
  if (!d || !editMode) return;

  if (tool === "label") {
    if (!d.moved) openLabelEditor(d.itemId, d.startCol);
    return;
  }
  // 指で触れただけ（動かしていない）なら、その1マスだけ塗る
  if (!d.active && d.moved) return;

  const a = Math.min(d.startCol, d.curCol);
  const b = Math.max(d.startCol, d.curCol);
  const first = colList[a];
  const last = colList[b];
  if (!first || !last) return;
  applyRange(d.itemId, lane, first.days[0], last.days[last.days.length - 1], tool === "erase");
}

function bindGanttPainting() {
  $("#g-rows").addEventListener("pointerdown", onTrackPointerDown);
}

/* ---------------- 作業名 ---------------- */
let labelTarget = null;

function openLabelEditor(itemId, colIndex) {
  if (!editMode) return;
  const item = findItem(itemId);
  const col = colList[colIndex];
  if (!item || !col) return;
  // 週間・月間ビューでは、その期間に既にある作業名を編集する（無ければ期間の先頭に付ける）
  const date = col.days.find((iso) => item.labels[iso]) || col.days[0];
  labelTarget = { itemId, date };
  $("#label-caption").textContent = `${item.name || "（名称なし）"}：${formatJP(date)} から表示`;
  const input = $("#label-input");
  input.value = item.labels[date] || "";
  $("#label-delete").hidden = !item.labels[date];
  openSheet("sheet-label");
  input.focus();
  input.select();
}

function commitLabel(text) {
  const t = labelTarget;
  labelTarget = null;
  closeSheet();
  if (!t) return;
  const item = findItem(t.itemId);
  if (!item) return;
  const before = item.labels[t.date] || "";
  if (before === text) return;
  const snap = { itemId: t.itemId, labels: { [t.date]: before || null } };
  if (dispatchLocal({ type: "setLabel", itemId: t.itemId, date: t.date, text })) pushUndo(snap);
}

function bindLabelEditor() {
  $("#label-form").addEventListener("submit", (e) => {
    e.preventDefault();
    commitLabel($("#label-input").value.trim());
  });
  $("#label-delete").addEventListener("click", () => commitLabel(""));
}

/* ---------------- 行のドラッグ並べ替え ---------------- */
let rowDrag = null;

function startRowDrag(ev, itemId, rowEl) {
  if (!editMode) return;
  if (ev.button !== undefined && ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const box = $("#g-rows");

  rowDrag = { itemId, rowEl, box, fromIndex: Array.from(box.children).indexOf(rowEl) };
  rowEl.classList.add("row-dragging");
  document.body.classList.add("row-drag-active");
  window.addEventListener("pointermove", onRowDragMove);
  window.addEventListener("pointerup", endRowDrag);
  window.addEventListener("pointercancel", cancelRowDrag);
}

// 行を実際にDOM上で動かしながらプレビューする。確定は pointerup。
function onRowDragMove(ev) {
  if (!rowDrag) return;
  ev.preventDefault();
  const { rowEl, box } = rowDrag;
  const rows = Array.from(box.children);
  const y = ev.clientY;

  for (const row of rows) {
    if (row === rowEl) continue;
    const rect = row.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      if (y < rect.top + rect.height / 2) box.insertBefore(rowEl, row);
      else box.insertBefore(rowEl, row.nextSibling);
      return;
    }
  }

  // 一番上／一番下からはみ出した場合
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && y < first.getBoundingClientRect().top) box.insertBefore(rowEl, first);
  else if (last && y > last.getBoundingClientRect().bottom) box.appendChild(rowEl);
}

function finishRowDrag() {
  window.removeEventListener("pointermove", onRowDragMove);
  window.removeEventListener("pointerup", endRowDrag);
  window.removeEventListener("pointercancel", cancelRowDrag);
  if (rowDrag) rowDrag.rowEl.classList.remove("row-dragging");
  document.body.classList.remove("row-drag-active");
  const ctx = rowDrag;
  rowDrag = null;
  return ctx;
}

function endRowDrag() {
  const ctx = finishRowDrag();
  if (!ctx) return;
  const domRows = Array.from(ctx.box.children);
  const domIndex = domRows.indexOf(ctx.rowEl);
  if (domIndex < 0 || domIndex === ctx.fromIndex) {
    renderGantt(); // 動かなかった場合もDOMを状態に戻す
    return;
  }
  const toIndex = dropIndexInState(ctx.itemId, domRows, domIndex);
  if (toIndex === null || !dispatchLocal({ type: "reorderItem", itemId: ctx.itemId, toIndex })) {
    renderGantt();
  }
}

/* 折りたたみで隠れている行があるため、画面での位置をそのまま state の添字には使えない。
   「すぐ上に見えている行の後ろに入れる」と読み替えて、本来の位置に変換する。
   その行が折りたたまれた親なら、隠れている配下ごと飛び越えて後ろに置く。 */
function dropIndexInState(itemId, domRows, domIndex) {
  const without = state.items.filter((it) => it.id !== itemId);
  if (without.length === state.items.length) return null; // 動かす行が見つからない

  let prevId = null;
  for (let i = domIndex - 1; i >= 0; i--) {
    const id = domRows[i].dataset.itemId;
    if (id && id !== itemId) { prevId = id; break; }
  }
  if (!prevId) return 0; // 一番上へ移動

  const prevIdx = without.findIndex((it) => it.id === prevId);
  if (prevIdx < 0) return null;

  let insertAt = prevIdx + 1;
  if (collapsedIds.has(prevId)) {
    const prevLevel = itemLevel(without[prevIdx]);
    while (insertAt < without.length && itemLevel(without[insertAt]) > prevLevel) insertAt++;
  }
  return insertAt;
}

function cancelRowDrag() {
  if (finishRowDrag()) renderGantt();
}

/* ---------------- 工種の追加 ---------------- */
// afterId を渡すとその行のすぐ下に、渡さなければ一番下に追加する
function addItem(afterId) {
  if (!editMode) return;
  const after = afterId ? findItem(afterId) : null;
  const last = state.items[state.items.length - 1];
  const base = after || last;
  const id = uid();
  const ok = dispatchLocal({
    type: "addItem",
    item: { id, name: "", bold: false, level: base ? itemLevel(base) : 0, cells: {}, labels: {}, actual: {} }
  });
  if (!ok) return;
  if (after) {
    const idx = state.items.findIndex((i) => i.id === afterId);
    dispatchLocal({ type: "reorderItem", itemId: id, toIndex: idx + 1 });
  }
  const rowEl = document.querySelector(`.g-row[data-item-id="${cssEscape(id)}"]`);
  if (rowEl && rowEl.scrollIntoView) rowEl.scrollIntoView({ block: "nearest" });
  openRowSheet(id, true);
}

/* ---------------- 工種の詳細（計画と実施の対比・行の操作） ---------------- */
let rowSheetId = null;
let rowLane = "plan";

function trackStats(map) {
  const days = Object.keys(map).filter((k) => map[k]).sort();
  if (!days.length) return null;
  return { first: days[0], last: days[days.length - 1], count: days.length, days };
}

function countUpTo(stats, iso) {
  if (!stats) return 0;
  let n = 0;
  for (const d of stats.days) { if (d <= iso) n++; else break; }
  return n;
}

function openRowSheet(itemId, focusName) {
  if (!findItem(itemId)) return;
  rowSheetId = itemId;
  rowLane = lane;
  renderRowSheet(true);
  openSheet("sheet-row");
  if (focusName && editMode) {
    const input = $("#row-name");
    input.focus();
    input.select();
  }
}

function refreshRowSheet() {
  if (openSheetId === "sheet-row" && rowSheetId) renderRowSheet(false);
}

function commitRowName() {
  if (!rowSheetId || !editMode) return;
  const item = findItem(rowSheetId);
  const input = $("#row-name");
  if (!item || !input) return;
  const name = input.value.trim();
  if (name !== item.name) dispatchLocal({ type: "renameItem", itemId: item.id, name });
}

function renderRowSheet(resetInputs) {
  const item = findItem(rowSheetId);
  if (!item) { closeSheet(); return; }
  const idx = state.items.indexOf(item);
  const level = itemLevel(item);

  $("#row-sheet-title").textContent = LEVEL_NAME[level] + "の詳細";
  const nameEl = $("#row-name");
  if (resetInputs || document.activeElement !== nameEl) nameEl.value = item.name;
  nameEl.readOnly = !editMode;

  $$("#sheet-row .edit-only").forEach((s) => { s.hidden = !editMode; });

  renderCompare(item);

  const st = itemStatus(item);
  const chip = $("#row-status-chip");
  chip.className = "row-tag " + (st || "doing");
  chip.textContent = STATUS_LABEL[st] || (Object.keys(item.actual).length ? "施工中" : "未入力");
  const doneBtn = $("#row-done");
  doneBtn.hidden = !editMode;
  doneBtn.textContent = item.done ? "完了を取り消す" : "完了にする";
  doneBtn.classList.toggle("btn-primary", !item.done);

  $$(".row-lane-btn").forEach((b) => b.classList.toggle("selected", b.dataset.lane === rowLane));
  if (resetInputs) fillRowRangeInputs(item);

  $("#row-outdent").disabled = level <= 0;
  $("#row-indent").disabled = level >= MAX_LEVEL;
  $("#row-up").disabled = idx <= 0;
  $("#row-down").disabled = idx >= state.items.length - 1;
  $("#row-bold").classList.toggle("btn-primary", !!item.bold);
  $("#row-level-note").textContent = `今の階層：${LEVEL_NAME[level]}（大工種 → 中工種 → 作業 の3段階）`;
}

function fillRowRangeInputs(item) {
  const stats = trackStats(rowLane === "actual" ? item.actual : item.cells) || trackStats(item.cells);
  let from, to;
  if (stats) {
    from = stats.first;
    to = stats.last;
  } else {
    const s = state.meta.startDate || todayISO();
    const e = state.meta.endDate || s;
    const t = todayISO();
    from = to = t < s ? s : t > e ? e : t;
  }
  $("#row-from").value = from;
  $("#row-to").value = to;
}

function renderCompare(item) {
  const box = $("#row-compare");
  box.textContent = "";
  const plan = trackStats(item.cells);
  const actual = trackStats(item.actual);

  const line = (cls, label, stats, emptyText) => {
    const row = el("div", "compare-row");
    row.appendChild(el("span", "compare-key" + cls, label));
    row.appendChild(el("span", "compare-val", stats
      ? (stats.first === stats.last ? formatJP(stats.first) : `${formatJP(stats.first)} 〜 ${formatJP(stats.last)}`)
      : emptyText));
    if (stats) row.appendChild(el("span", "compare-days", `${stats.count}日`));
    box.appendChild(row);
  };
  line("", "計画", plan, "まだ入力されていません");
  line(" actual", "実施", actual, "まだ入力されていません");

  const note = el("div", "compare-note");
  const today = todayISO();
  const add = (text, cls) => note.appendChild(el(cls ? "span" : "span", cls || "", text));

  if (!plan && !actual) {
    add("バーを引くと、ここに計画と実施の差が表示されます。");
  } else if (plan && !actual) {
    if (plan.first <= today) add("計画では着手済みの日付ですが、実施がまだ入力されていません。", "late");
    else add(`計画の着手まで あと${diffDays(plan.first, today)}日 です。`);
  } else if (!plan && actual) {
    add("実施だけが入力されています（計画のバーがありません）。");
  } else {
    const startDiff = diffDays(actual.first, plan.first);
    add("着手：");
    if (startDiff > 0) add(`計画より${startDiff}日遅れ`, "late");
    else if (startDiff < 0) add(`計画より${-startDiff}日早い`, "early");
    else add("計画どおり");

    const planTo = countUpTo(plan, today);
    const actualTo = countUpTo(actual, today);
    add(`　／　今日まで：計画${planTo}日ぶんに対し、実施${actualTo}日ぶん`);
    if (actualTo < planTo) add(`（${planTo - actualTo}日ぶん少ない）`, "late");
    else if (actualTo > planTo) add(`（${actualTo - planTo}日ぶん多い）`, "early");

    if (plan.last < today) {
      const endDiff = diffDays(actual.last, plan.last);
      add("　／　最終日：");
      if (endDiff > 0) add(`計画より${endDiff}日遅い`, "late");
      else if (endDiff < 0) add(`計画より${-endDiff}日早い`, "early");
      else add("計画どおり");
    }
  }
  box.appendChild(note);
}

function bindRowSheet() {
  $("#row-name").addEventListener("change", commitRowName);
  $("#row-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });

  $$(".row-lane-btn").forEach((b) => b.addEventListener("click", () => {
    rowLane = b.dataset.lane;
    const item = findItem(rowSheetId);
    $$(".row-lane-btn").forEach((x) => x.classList.toggle("selected", x.dataset.lane === rowLane));
    if (item) fillRowRangeInputs(item);
  }));

  const rangeAction = (erase) => {
    const from = $("#row-from").value;
    const to = $("#row-to").value;
    if (!from || !to) { showToast("開始日と終了日を入力してください"); return; }
    const s = state.meta.startDate, e = state.meta.endDate;
    const lo = from < to ? from : to;
    const hi = from < to ? to : from;
    if ((s && hi < s) || (e && lo > e)) { showToast("工期の外の日付です"); return; }
    // 工期からはみ出したぶんは切り落とす（見えない場所にバーが残らないように）
    const a = s && lo < s ? s : lo;
    const b = e && hi > e ? e : hi;
    const changed = applyRange(rowSheetId, rowLane, a, b, erase);
    const what = rowLane === "actual" ? "実施" : "計画";
    if (changed) showToast(erase ? `${what}のバーを消しました` : `${what}のバーを引きました`);
    else showToast(erase ? "消すバーがありません" : "すでに同じ内容です");
  };
  $("#row-range-paint").addEventListener("click", () => rangeAction(false));
  $("#row-range-erase").addEventListener("click", () => rangeAction(true));

  const withItem = (fn) => () => {
    const item = findItem(rowSheetId);
    if (item) fn(item);
  };
  $("#row-outdent").addEventListener("click", withItem((item) => {
    const lv = itemLevel(item);
    if (lv > 0) dispatchLocal({ type: "setLevel", itemId: item.id, level: lv - 1 });
  }));
  $("#row-indent").addEventListener("click", withItem((item) => {
    const lv = itemLevel(item);
    if (lv < MAX_LEVEL) dispatchLocal({ type: "setLevel", itemId: item.id, level: lv + 1 });
  }));
  $("#row-bold").addEventListener("click", withItem((item) => {
    dispatchLocal({ type: "toggleBold", itemId: item.id });
  }));
  $("#row-up").addEventListener("click", withItem((item) => {
    dispatchLocal({ type: "moveItem", itemId: item.id, dir: -1 });
  }));
  $("#row-down").addEventListener("click", withItem((item) => {
    dispatchLocal({ type: "moveItem", itemId: item.id, dir: 1 });
  }));
  $("#row-add-below").addEventListener("click", withItem((item) => {
    commitRowName();
    addItem(item.id);
  }));
  $("#row-done").addEventListener("click", withItem((item) => {
    if (dispatchLocal({ type: "setDone", itemId: item.id, done: !item.done })) {
      showToast(item.done ? "完了にしました" : "完了を取り消しました");
    }
  }));
  $("#row-delete").addEventListener("click", withItem((item) => {
    if (!confirm(`「${item.name || "（名称なし）"}」を削除しますか？\nこの行のバーや作業名も一緒に消えます。`)) return;
    const id = item.id;
    rowSheetId = null; // 閉じる時に名前の確定が走らないように先に外す
    closeSheet();
    dispatchLocal({ type: "removeItem", itemId: id });
  }));
}

/* ---------------- 出来高（表とS字カーブ） ---------------- */
function renderProgress() {
  const months = monthListBetween(state.meta.startDate, state.meta.endDate);
  const table = $("#progress-table");
  table.textContent = "";

  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", "", "月"));
  const thPlan = el("th", "num");
  thPlan.appendChild(el("span", "key-plan", "計画(%)"));
  const thActual = el("th", "num");
  thActual.appendChild(el("span", "key-actual", "実績(%)"));
  hr.appendChild(thPlan);
  hr.appendChild(thActual);
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  months.forEach((mo) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", mo.label));
    ["plan", "actual"].forEach((kind) => {
      const td = el("td", "num");
      const input = el("input", "input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "any";
      input.inputMode = "decimal";
      input.dataset.kind = kind;
      input.dataset.month = mo.key;
      input.value = state.progress[kind][mo.key] ?? "";
      input.disabled = !editMode;
      input.setAttribute("aria-label", `${mo.label} ${kind === "plan" ? "計画" : "実績"}(%)`);
      input.addEventListener("change", (e) => {
        const value = e.target.value === "" ? null : Number(e.target.value);
        dispatchLocal({ type: "setProgress", kind, monthKey: mo.key, value });
      });
      td.appendChild(input);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  $("#progress-note").hidden = editMode;
  renderChart();
}

function renderChart() {
  const canvas = $("#progress-canvas");
  const box = canvas.parentElement;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return; // タブが隠れている間は描かない（表示された時に描き直す）
  drawChart(canvas, w, h, window.devicePixelRatio || 1);
}

// 計画＝青、実績＝赤（工程表のバーと同じ色分け）
function drawChart(canvas, w, h, scale) {
  const months = monthListBetween(state.meta.startDate, state.meta.endDate);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 14, padT = 30, padB = 40;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const font = '"Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif';

  ctx.lineWidth = 1;
  ctx.font = "11px " + font;
  ctx.textAlign = "right";
  for (let p = 0; p <= 100; p += 25) {
    const y = Math.round(padT + plotH * (1 - p / 100)) + 0.5;
    ctx.strokeStyle = p === 0 ? "#cbd5e1" : "#e5e9f0";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = "#64748b";
    ctx.fillText(p + "%", padL - 6, y + 4);
  }

  // 凡例
  ctx.textAlign = "left";
  ctx.font = "600 12px " + font;
  [["計画", "#2563eb", padL], ["実績", "#dc2626", padL + 62]].forEach(([label, color, x]) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, 10, 16, 4);
    ctx.fillStyle = "#334155";
    ctx.fillText(label, x + 21, 16);
  });

  if (!months.length) return;
  const stepX = months.length > 1 ? plotW / (months.length - 1) : 0;
  const xOf = (idx) => padL + (months.length > 1 ? stepX * idx : plotW / 2);

  // 月が多いと文字が重なるので、幅に合わせて間引く
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(plotW / 38))));
  ctx.textAlign = "center";
  ctx.font = "11px " + font;
  months.forEach((mo, idx) => {
    if (idx % every !== 0) return;
    const x = xOf(idx);
    ctx.fillStyle = "#475569";
    ctx.fillText(mo.month + "月", x, h - padB + 16);
    if (idx === 0 || mo.month === 1 || (idx - every < 0)) {
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(String(mo.year), x, h - padB + 30);
    }
  });

  const plot = (key, color) => {
    const pts = [];
    months.forEach((mo, idx) => {
      const val = state.progress[key][mo.key];
      if (val === undefined || val === null || val === "" || !Number.isFinite(Number(val))) return;
      pts.push([xOf(idx), padT + plotH * (1 - Math.max(0, Math.min(100, Number(val))) / 100)]);
    });
    if (!pts.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    pts.forEach(([x, y]) => {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  };
  plot("plan", "#2563eb");
  plot("actual", "#dc2626");
}

/* ---------------- 印刷レイアウト ----------------
   画面の表をそのまま印刷すると、工種が多いときに縦に切れてしまい読めない。
   そこで印刷時は専用のDOMを組み直し、
   ・工種（縦）は1枚に収める
   ・工期（横）が長いときだけ2枚目・3枚目…と横に続く
   ・折りたたんだ工種は出さない
   という紙面にする。単位はA3横の実寸(mm)で計算する。 */
const PRINT_MM = {
  pageW: 420, pageH: 297, margin: 8,
  safety: 1,       // 端数で1枚あふれないための余裕
  labelW: 44,      // 項目欄の幅
  headH: 26,       // 工事情報ブロックの高さ（CSSで固定してある）
  theadH: 12,      // 月・日・曜日の3行ぶん（各行に高さを指定する）
  colPref: { day: 3.0, week: 9, month: 16 },   // 1列の理想幅（広げすぎない上限）
  colMin:  { day: 2.2, week: 6, month: 11 },   // 1列の下限（これ以上は詰めない）
  rowPref: 7,      // 1行の理想高さ
  rowMin: 3.6      // 1行の下限
};

// 紙1枚の実際の描画領域（CSSの .print-page と必ず同じ値にすること）
function printPageBox() {
  const P = PRINT_MM;
  return {
    w: P.pageW - P.margin * 2 - P.safety,
    h: P.pageH - P.margin * 2 - P.safety
  };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* 期間内の色を1つの背景にまとめる。全部同じ色ならベタ塗り、
   途中で色が変わる／塗っていない日が混ざる場合は日数の比率どおりに描き分ける。 */
function bucketBackground(colorAt, days) {
  if (days.length === 1) return colorAt(days[0]) || "";
  const segs = [];
  let painted = false;
  days.forEach((iso) => {
    const color = colorAt(iso) || null;
    if (color) painted = true;
    const last = segs[segs.length - 1];
    if (last && last.color === color) last.n++;
    else segs.push({ color, n: 1 });
  });
  if (!painted) return "";
  if (segs.length === 1) return segs[0].color;
  const stops = [];
  let acc = 0;
  segs.forEach((s) => {
    const from = (acc / days.length) * 100;
    acc += s.n;
    const to = (acc / days.length) * 100;
    const c = s.color || "transparent";
    stops.push(`${c} ${from.toFixed(2)}%`, `${c} ${to.toFixed(2)}%`);
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function backgroundLayer(value) {
  if (!value) return "none";
  return value.startsWith("linear-gradient") ? value : `linear-gradient(${value}, ${value})`;
}

function buildPrintLayout() {
  const root = document.getElementById("print-root");
  if (!root) return;
  root.textContent = "";

  const cols = buildColumns();
  const rows = visibleRows();
  if (!cols.length || !rows.length) return;

  const P = PRINT_MM;
  const box = printPageBox();
  const gridW = box.w - P.labelW;
  const gridH = box.h - P.headH - P.theadH;

  // 横：1枚に入る列数。最後の紙だけスカスカにならないよう、枚数を出してから均等に割り直す。
  let perPage = Math.max(1, Math.floor(gridW / P.colMin[viewMode]));
  const across = Math.max(1, Math.ceil(cols.length / perPage));
  perPage = Math.ceil(cols.length / across);
  const colWmm = Math.min(gridW / perPage, P.colPref[viewMode]);

  // 縦：工種は原則1枚に収める。下限まで詰めても入らないときだけ行も分ける。
  let rowH = Math.min(gridH / rows.length, P.rowPref);
  let perBand = rows.length;
  if (rowH < P.rowMin) {
    rowH = P.rowMin;
    perBand = Math.max(1, Math.floor(gridH / rowH));
  }

  const colChunks = chunkArray(cols, perPage);
  const rowBands = chunkArray(rows, perBand);
  const total = colChunks.length * rowBands.length;

  let n = 0;
  rowBands.forEach((band) => {
    colChunks.forEach((cc) => {
      n++;
      root.appendChild(buildPrintPage(band, cc, colWmm, rowH, n, total));
    });
  });

  const progressPage = buildProgressPage();
  if (progressPage) root.appendChild(progressPage);
}

function clearPrintLayout() {
  const root = document.getElementById("print-root");
  if (root) root.textContent = "";
  document.body.classList.remove("printing");
}

function buildPrintHead(cols, pageNo, pageTotal) {
  const m = state.meta;
  const head = el("div", "print-head");
  head.appendChild(el("div", "print-title", "工 事 工 程 表"));

  const grid = el("div", "print-meta");
  const period = [m.startDate ? formatJP(m.startDate) : "", m.endDate ? formatJP(m.endDate) : ""]
    .filter(Boolean).join(" 〜 ");
  [
    ["工　事　名", m.projectName],
    ["工 事 場 所", m.location],
    ["発　注　者", m.orderer],
    ["設 計 ・ 監 理", m.supervisor],
    ["施　工　者", m.contractor],
    ["契 約 年 月 日", m.contractDate ? formatJP(m.contractDate) : ""],
    ["工　　　期", period],
    ["作　成　日", m.createdDate ? formatJP(m.createdDate) : ""]
  ].forEach(([k, v]) => {
    const cell = el("div", "print-meta-item");
    cell.appendChild(el("span", "print-meta-key", k));
    cell.appendChild(el("span", "print-meta-val", v || ""));
    grid.appendChild(cell);
  });
  head.appendChild(grid);

  const sub = el("div", "print-subhead");
  const first = cols[0];
  const last = cols[cols.length - 1];
  sub.appendChild(el("span", "", `この紙の期間：${formatJP(first.days[0])} 〜 ${formatJP(last.days[last.days.length - 1])}`));

  const legend = el("span", "print-legend");
  const planKey = el("span");
  planKey.appendChild(el("i"));
  planKey.appendChild(document.createTextNode("計画（上段）"));
  const actualKey = el("span");
  actualKey.appendChild(el("i", "actual"));
  actualKey.appendChild(document.createTextNode("実施（下段）"));
  legend.appendChild(planKey);
  legend.appendChild(actualKey);
  sub.appendChild(legend);

  sub.appendChild(el("span", "", `${pageNo} / ${pageTotal}`));
  head.appendChild(sub);

  return head;
}

/* 作業名は1日ぶんのセル幅（数mm）に収まらないので、はみ出して表示する。
   ただし紙の端で切れると読めなくなるため、右に入らなければ左向きに伸ばし、
   どちらにも入らない時だけ広い方に寄せて「…」で締める。
   印刷CSSは画面では効かず実測できないので、幅は同じフォント指定で文字送りを計算して見積もる。 */
const PRINT_FONT = '"Yu Gothic", "Meiryo", "Hiragino Sans", "Segoe UI", sans-serif';
const PX_PER_MM = 96 / 25.4;
let printMeasureCtx = null;

function measureTextMm(text, fontPt) {
  if (!printMeasureCtx) printMeasureCtx = document.createElement("canvas").getContext("2d");
  printMeasureCtx.font = fontPt + "pt " + PRINT_FONT;
  return printMeasureCtx.measureText(text).width / PX_PER_MM;
}

function buildPrintLabel(text, colIndex, colCount, colWmm, fontPt) {
  const span = el("span", "p-bar-label", text);

  const need = measureTextMm(text, fontPt) + 1.2; // 左右の余白ぶん
  const roomRight = (colCount - colIndex) * colWmm;  // このセルの左端から紙の右端まで
  // 左は日付欄の左端まで。項目（工種名）欄まで伸ばすと工種名が隠れてしまうので含めない。
  const roomLeft = (colIndex + 1) * colWmm;

  if (need <= roomRight) return span; // 右へはみ出せば収まる（通常）

  if (need <= roomLeft) {
    span.classList.add("p-bar-label-left"); // 左向きに伸ばす
    return span;
  }

  // どちら向きでも紙に収まらない：広い方へ寄せ、末尾を「…」にして切れたと分かるようにする
  const toLeft = roomLeft > roomRight;
  if (toLeft) span.classList.add("p-bar-label-left");
  span.classList.add("p-bar-label-clip");
  span.style.maxWidth = Math.max(6, (toLeft ? roomLeft : roomRight) - 1.2).toFixed(2) + "mm";
  return span;
}

function buildPrintPage(rows, cols, colWmm, rowH, pageNo, pageTotal) {
  const P = PRINT_MM;
  const page = el("section", "print-page");
  page.appendChild(buildPrintHead(cols, pageNo, pageTotal));

  const table = el("table", "print-table");
  const fontPt = Math.max(5, Math.min(8, rowH * 1.15));
  table.style.fontSize = fontPt.toFixed(2) + "pt";

  const colgroup = el("colgroup");
  const firstCol = el("col");
  firstCol.style.width = P.labelW + "mm";
  colgroup.appendChild(firstCol);
  cols.forEach(() => {
    const c = el("col");
    c.style.width = colWmm.toFixed(3) + "mm";
    colgroup.appendChild(c);
  });
  table.appendChild(colgroup);

  const thead = el("thead");
  const groupRow = el("tr");
  const th0 = el("th", "p-th p-label", "項　目");
  th0.rowSpan = 3;
  groupRow.appendChild(th0);
  let i = 0;
  while (i < cols.length) {
    const key = cols[i].groupKey;
    let span = 0;
    while (i + span < cols.length && cols[i + span].groupKey === key) span++;
    const th = el("th", "p-th p-month", cols[i].groupLabel);
    th.colSpan = span;
    groupRow.appendChild(th);
    i += span;
  }
  thead.appendChild(groupRow);

  const topRow = el("tr");
  const botRow = el("tr");
  cols.forEach((col) => {
    const wk = col.cls ? " td-" + col.cls : "";
    topRow.appendChild(el("th", "p-th" + wk, col.top));
    botRow.appendChild(el("th", "p-th" + wk, col.bottom));
  });
  thead.appendChild(topRow);
  thead.appendChild(botRow);
  // 見出しの高さを決め打ちにして、本体の行数計算とズレないようにする
  const headRowH = (P.theadH / 3).toFixed(3) + "mm";
  [groupRow, topRow, botRow].forEach((tr) => { tr.style.height = headRowH; });
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((row) => {
    const item = row.item;
    const tr = el("tr");
    tr.style.height = rowH.toFixed(3) + "mm";

    // 折りたたんだ親は、中に隠れている行があることが紙面でも分かるようにする
    const nameTd = el("td", "p-label lv" + row.level + (item.bold ? " p-bold" : ""),
      (row.collapsed ? "▶ " : "") + (item.name || ""));
    nameTd.style.paddingLeft = (1.5 + row.level * 3).toFixed(2) + "mm";
    const st = itemStatus(item);
    if (st) nameTd.appendChild(el("span", "p-tag " + st, STATUS_LABEL[st]));
    tr.appendChild(nameTd);

    cols.forEach((col, ci) => {
      const td = el("td", "p-cell" + (col.cls ? " td-" + col.cls : ""));
      const planBg = bucketBackground((iso) => planColorOf(item.cells[iso]), col.days);
      const actualBg = bucketBackground((iso) => (item.actual[iso] ? ACTUAL_COLOR : null), col.days);
      if (planBg || actualBg) {
        td.style.backgroundImage = backgroundLayer(planBg) + ", " + backgroundLayer(actualBg);
      }
      const iso = col.days.find((d) => item.labels[d]);
      if (iso) td.appendChild(buildPrintLabel(item.labels[iso], ci, cols.length, colWmm, fontPt));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  page.appendChild(table);

  return page;
}

// 出来高率（表とS字カーブ）は最後の1枚にまとめる
function buildProgressPage() {
  const months = monthListBetween(state.meta.startDate, state.meta.endDate);
  if (!months.length) return null;

  const page = el("section", "print-page print-page-progress");
  page.appendChild(el("div", "print-title", "出 来 高 率（S字カーブ）"));

  const table = el("table", "print-progress-table");
  const head = el("tr");
  head.appendChild(el("th", "", "月"));
  months.forEach((mo) => head.appendChild(el("th", "", mo.label)));
  table.appendChild(head);

  [["計 画 (%)", "plan"], ["実 績 (%)", "actual"]].forEach(([label, kind]) => {
    const tr = el("tr");
    tr.appendChild(el("th", "", label));
    months.forEach((mo) => {
      const v = state.progress[kind][mo.key];
      tr.appendChild(el("td", "", (v === undefined || v === null || v === "") ? "" : String(v)));
    });
    table.appendChild(tr);
  });
  page.appendChild(table);

  // 画面のグラフは隠れていることがあるので、印刷用に別の大きさで描き直して画像にする
  try {
    const canvas = document.createElement("canvas");
    drawChart(canvas, 1400, 420, 2);
    const img = el("img", "print-chart");
    img.src = canvas.toDataURL("image/png");
    page.appendChild(img);
  } catch (e) { /* 画像化できない環境ではグラフ無しで印刷する */ }

  return page;
}

function doPrint() {
  closeSheet();
  document.body.classList.add("printing");
  buildPrintLayout();
  window.print();
}

/* ---------------- メニュー（印刷・出力・共有など） ---------------- */
function exportExcel() {
  closeSheet();
  try {
    window.KouteiXlsx.exportSchedule(state);
    showToast("Excelファイルを出力しました");
  } catch (e) {
    alert("Excel出力に失敗しました：" + e.message);
  }
}

async function shareLink() {
  closeSheet();
  const title = state.meta.projectName || "工事工程表";
  if (navigator.share) {
    try {
      await navigator.share({ title, url: location.href });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // 共有を取りやめた
    }
  }
  try {
    await navigator.clipboard.writeText(location.href);
    showToast("共有URLをコピーしました");
  } catch (e) {
    showToast("コピーできませんでした。アドレスバーのURLを共有してください");
  }
}

function exportJSON() {
  closeSheet();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.meta.projectName || "工事工程表") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bindMenu() {
  $("#btn-menu").addEventListener("click", () => openSheet("sheet-menu"));
  $("#btn-print").addEventListener("click", doPrint);
  $("#menu-print").addEventListener("click", doPrint);
  $("#btn-excel").addEventListener("click", exportExcel);
  $("#menu-excel").addEventListener("click", exportExcel);
  $("#menu-share").addEventListener("click", shareLink);
  $("#btn-export").addEventListener("click", exportJSON);
  $("#menu-help").addEventListener("click", () => openSheet("sheet-help"));

  // Ctrl+P など、ボタン以外から印刷された時も同じ紙面になるようにする
  window.addEventListener("beforeprint", () => {
    document.body.classList.add("printing");
    buildPrintLayout();
  });
  window.addEventListener("afterprint", clearPrintLayout);

  $("#btn-import").addEventListener("click", () => {
    if (!editMode) return;
    closeSheet();
    $("#file-import").click();
  });
  $("#file-import").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm("今の工程表の内容を、読み込んだファイルの内容で丸ごと置き換えます。よろしいですか？")) return;
        if (dispatchLocal({ type: "resetAll", state: normalizeState(parsed) })) showToast("バックアップを読み込みました");
      } catch (err) {
        alert("ファイルの読み込みに失敗しました。");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });
}

/* ---------------- 全体の描画 ---------------- */
function renderAll() {
  renderHeader();
  renderRangeUI();
  renderGantt();
  renderProgress();
}

/* ---------------- init ---------------- */
function init() {
  if (!roomId) {
    // 工事が指定されていない場合は一覧へ
    location.replace("index.html");
    return;
  }

  const loaded = loadLocal();
  state = loaded ? normalizeState(loaded) : defaultState();

  bindSheets();
  bindTabs();
  bindHeaderEvents();
  bindGanttPainting();
  bindDock();
  bindMenu();
  bindViewSwitch();
  bindRangeFilter();
  bindLabelEditor();
  bindRowSheet();
  bindEditMode();
  renderAll();
  saveLocal();
  if (loaded) autoScrollToTodayOnce();

  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (currentTab === "progress") renderChart(); })
      .observe($("#progress-canvas").parentElement);
  }

  startSync();
}

init();
})();
