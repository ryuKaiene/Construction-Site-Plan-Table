(() => {
"use strict";

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
const PALETTE = [
  "#4f8ef7", "#f76c6c", "#f7b84f", "#4fd17f", "#a678f2",
  "#f76ccb", "#2ecfcf", "#8a8f98", "#e0c34f", "#222222"
];
const MAX_LEVEL = 2; // 大工種 → 中工種 → 小工種（作業）の3階層
const META_INPUT_ID = {
  projectName: "f-projectName", orderer: "f-orderer", location: "f-location",
  supervisor: "f-supervisor", contractor: "f-contractor",
  contractDate: "f-contractDate", createdDate: "f-createdDate",
  startDate: "f-startDate", endDate: "f-endDate"
};

/* ---------------- date helpers ---------------- */
function pad2(n) { return String(n).padStart(2, "0"); }

function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function dateRangeArray(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  let cur = parseISO(startISO);
  const end = parseISO(endISO);
  if (cur > end) return out;
  while (cur <= end) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function dateRangeISO(startISO, endISO) {
  return dateRangeArray(startISO, endISO).map(isoDate);
}

function formatJP(iso) {
  if (!iso) return "";
  const d = parseISO(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function monthListBetween(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  const s = parseISO(startISO), e = parseISO(endISO);
  let y = s.getFullYear(), m = s.getMonth();
  while (y < e.getFullYear() || (y === e.getFullYear() && m <= e.getMonth())) {
    out.push({ key: `${y}-${pad2(m + 1)}`, label: `${y}年${m + 1}月` });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

function uid() {
  return "id" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* 旧バージョンで作られた項目（level / labels を持たない）でも安全に扱えるよう、
   op から受け取った item は必ずここを通してから state に入れる。 */
function normalizeItem(raw) {
  const it = raw && typeof raw === "object" ? raw : {};
  return {
    id: it.id || uid(),
    name: typeof it.name === "string" ? it.name : "",
    bold: !!it.bold,
    level: Math.max(0, Math.min(MAX_LEVEL, Number(it.level) || 0)),
    cells: it.cells && typeof it.cells === "object" ? it.cells : {},
    labels: it.labels && typeof it.labels === "object" ? it.labels : {}
  };
}

/* ---------------- default state ----------------
   実際の工事情報は新規作成フォームからサーバーに登録され、resetAll op として
   同期されてくる。ここはサーバーに繋がるまでの一時的な土台。 */
function defaultState() {
  const today = new Date();
  const monthLater = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
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
    items: [
      { id: uid(), name: "準備工", bold: true, level: 0, cells: {}, labels: {} },
      { id: uid(), name: "仮設工", bold: true, level: 0, cells: {}, labels: {} },
      { id: uid(), name: "土工", bold: true, level: 0, cells: {}, labels: {} },
      { id: uid(), name: "構造物工", bold: true, level: 0, cells: {}, labels: {} },
      { id: uid(), name: "付帯工", bold: true, level: 0, cells: {}, labels: {} },
      { id: uid(), name: "後片付け工", bold: true, level: 0, cells: {}, labels: {} }
    ],
    progress: { plan: {}, actual: {} }
  };
}

let state = null;
let currentTool = { type: "color", value: PALETTE[0] };
let painting = false;
let paintMode = null; // 'paint' | 'erase'

/* ---------------- realtime sync (HTTP polling against D1-backed op log) ---------------- */
// 工事案件ごとに部屋を分ける。?project= が無い場合は一覧へ戻す。
// 旧URL(?room=) を開いた人のために room も見る。
const params = new URLSearchParams(location.search);
const roomId = params.get("project") || params.get("room") || "";
const LASTSEQ_KEY = "koutei-hyou-lastseq-v1:" + roomId;
const POLL_INTERVAL_MS = 2000;
const BATCH_LIMIT = 500;

const STORAGE_KEY = "koutei-hyou-state-v1:" + roomId;
// 表示単位（日別／週間／月間）は見え方の設定なので、opとして同期せず端末ごとに覚える
const VIEW_KEY = "koutei-hyou-view-v1:" + roomId;
// 表示期間の絞り込みも見え方の設定。opにはせず端末ごとに覚える
const RANGE_KEY = "koutei-hyou-range-v1:" + roomId;
// 折りたたみも見え方の設定。共有すると他の人の画面が勝手に畳まれてしまうので端末ごとに覚える
const COLLAPSE_KEY = "koutei-hyou-collapsed-v1:" + roomId;

let lastSeq = Number(localStorage.getItem(LASTSEQ_KEY) || "0") || 0;
const appliedSeqs = new Set();
let offlineQueue = [];
let syncTimer = null;

function setConnStatus(status) {
  const el = document.getElementById("conn-status");
  if (!el) return;
  el.classList.remove("conn-online", "conn-offline");
  if (status === "online") {
    el.classList.add("conn-online");
    el.textContent = "🟢 自動同期中";
  } else {
    el.classList.add("conn-offline");
    el.textContent = "⚪ オフライン（ローカル保存モード）";
  }
}

function saveLastSeq() {
  try { localStorage.setItem(LASTSEQ_KEY, String(lastSeq)); } catch (e) { /* ignore */ }
}

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
  syncTimer = setInterval(async () => {
    await flushOfflineQueue();
    await syncPull();
  }, POLL_INTERVAL_MS);
}

/* ---------------- op application (mirrors server logic) ---------------- */
function applyOp(op) {
  switch (op.type) {
    case "paint": {
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) item.cells[op.date] = op.color;
      break;
    }
    case "erase": {
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) {
        delete item.cells[op.date];
        delete item.labels[op.date];
      }
      break;
    }
    // 週間・月間ビューで1セルを塗った時。日単位のデータに展開して持つので、
    // 保存されている工程はどのビューで編集しても日単位のまま。
    case "paintRange": {
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) item.cells[iso] = op.color;
      }
      break;
    }
    case "eraseRange": {
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) {
        for (const iso of dateRangeISO(op.from, op.to)) {
          delete item.cells[iso];
          delete item.labels[iso];
        }
      }
      break;
    }
    case "setLabel": {
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) {
        if (op.text) item.labels[op.date] = op.text;
        else delete item.labels[op.date];
      }
      break;
    }
    case "setLevel": {
      const item = state.items.find((i) => i.id === op.itemId);
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
      const item = state.items.find((i) => i.id === op.itemId);
      if (item) item.name = op.name;
      break;
    }
    case "toggleBold": {
      const item = state.items.find((i) => i.id === op.itemId);
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
      state.progress[op.kind][op.monthKey] = op.value;
      break;
    case "resetAll":
      state = normalizeState(op.state);
      break;
  }
}

function renderForOp(op) {
  switch (op.type) {
    case "paint":
    case "erase":
    case "setLabel":
      refreshCell(op.itemId, op.date);
      break;
    case "paintRange":
    case "eraseRange": {
      // 週間・月間ビューでは複数日が1セルにまとまるので、同じセルは1回だけ描き直す
      const done = new Set();
      for (const iso of dateRangeISO(op.from, op.to)) {
        const td = findCell(op.itemId, iso);
        if (!td || done.has(td)) continue;
        done.add(td);
        refreshCell(op.itemId, iso);
      }
      break;
    }
    case "setLevel":
      renderGantt();
      break;
    case "addItem":
    case "removeItem":
    case "moveItem":
    case "reorderItem":
      renderGantt();
      break;
    case "renameItem": {
      const el = document.querySelector(
        `tr[data-item-id="${cssEscape(op.itemId)}"] .item-name-input`
      );
      if (el && document.activeElement !== el) el.value = op.name;
      break;
    }
    case "toggleBold": {
      const item = state.items.find((i) => i.id === op.itemId);
      const el = document.querySelector(
        `tr[data-item-id="${cssEscape(op.itemId)}"] .item-name-input`
      );
      if (el) el.classList.toggle("bold", item ? item.bold : false);
      break;
    }
    case "setMeta": {
      if (op.key === "startDate" || op.key === "endDate") {
        renderRangeUI();
        renderGantt();
        renderProgress();
      } else {
        const id = META_INPUT_ID[op.key];
        const el = id && document.getElementById(id);
        if (el && document.activeElement !== el) el.value = state.meta[op.key] || "";
        if (op.key === "projectName") renderToolbarName();
      }
      break;
    }
    case "setProgress": {
      const el = document.querySelector(
        `#progress-table input[data-kind="${op.kind}"][data-month="${op.monthKey}"]`
      );
      if (el && document.activeElement !== el) el.value = op.value ?? "";
      drawChart(monthListBetween(state.meta.startDate, state.meta.endDate));
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

function findCell(itemId, date) {
  const direct = document.querySelector(
    `.gantt-cell[data-item-id="${cssEscape(itemId)}"][data-date="${date}"]`
  );
  if (direct) return direct;
  // 週間・月間ビューでは、その日をまとめている列のセルを返す
  const col = colList.find((c) => c.days.includes(date));
  if (!col) return null;
  return document.querySelector(
    `.gantt-cell[data-item-id="${cssEscape(itemId)}"][data-col-key="${col.key}"]`
  );
}

// そのセルが受け持つ日。日別ビューなら1日、週間・月間ビューならその期間ぶん。
function cellDays(td) {
  const col = colList.find((c) => c.key === td.dataset.colKey);
  if (col) return col.days;
  return td.dataset.date ? [td.dataset.date] : [];
}

/* 期間内の色を1つの背景にまとめる。全部同じ色ならベタ塗り、
   途中で色が変わる／塗っていない日が混ざる場合は日数の比率どおりに描き分ける。 */
function bucketBackground(cells, days) {
  if (days.length === 1) return cells[days[0]] || "";
  const segs = [];
  let painted = false;
  days.forEach((iso) => {
    const color = cells[iso] || null;
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

// 状態から1セルを描き直す。どのビューでも同じ処理で済ませられる。
function refreshCell(itemId, date) {
  const item = state.items.find((i) => i.id === itemId);
  const td = findCell(itemId, date);
  if (!item || !td) return;
  const days = cellDays(td);
  if (!days.length) return;
  const cells = item.cells && typeof item.cells === "object" ? item.cells : {};
  const labels = item.labels && typeof item.labels === "object" ? item.labels : {};
  td.style.background = bucketBackground(cells, days) || "";
  const labelIso = days.find((iso) => labels[iso]);
  renderCellLabel(td, labelIso ? labels[labelIso] : "");
}

// A cell's label is the作業名 shown starting at that cell and overflowing to the right.
function renderCellLabel(td, text) {
  const existing = td.querySelector(".bar-label");
  if (existing) existing.remove();
  if (!text) return;
  const span = document.createElement("span");
  span.className = "bar-label";
  span.textContent = text;
  td.appendChild(span);
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
  saveLocal();
}

/* ---------------- persistence (local cache / offline fallback) ---------------- */
function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore quota errors */ }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

/* ---------------- rendering: header ---------------- */
function renderHeader() {
  const m = state.meta;
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = m[key] || "";
    // 日付欄は readonly でもカレンダーから変えられてしまう環境があるので disabled にする
    if (el.type === "date") el.disabled = !editMode;
    else el.readOnly = !editMode;
  });
  renderToolbarName();
}

function renderToolbarName() {
  const el = document.getElementById("toolbar-project-name");
  if (el) el.textContent = state.meta.projectName || "工事工程表";
}

function bindHeaderEvents() {
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    document.getElementById(id).addEventListener("change", (e) => {
      dispatchLocal({ type: "setMeta", key, value: e.target.value });
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
  if (!editMode) closeLabelEditor();
  document.body.classList.toggle("edit-mode", editMode);
  renderEditModeUI();
  renderAll();
}

function renderEditModeUI() {
  const btn = $("#btn-edit-mode");
  if (btn) {
    btn.textContent = editMode ? "🔒 編集を終了" : "✏️ 編集する";
    btn.title = editMode
      ? "編集を終了して、閲覧のみに戻す"
      : "工程表を編集できるようにする";
    btn.setAttribute("aria-pressed", editMode ? "true" : "false");
  }
  const badge = $("#edit-status");
  if (badge) {
    badge.textContent = editMode ? "✏️ 編集中" : "🔒 閲覧のみ";
    badge.title = editMode
      ? "この画面での操作が全員に同期されます"
      : "「✏️ 編集する」を押すまで書き換えられません";
    badge.className = "edit-status" + (editMode ? " edit-status-on" : "");
  }
  ["btn-add-item", "btn-add-item-bottom", "btn-import"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !editMode;
  });
}

function bindEditMode() {
  const btn = $("#btn-edit-mode");
  if (btn) btn.addEventListener("click", () => setEditMode(!editMode));
  renderEditModeUI();
}

/* ---------------- 表示単位（日別／週間／月間） ----------------
   セルのデータは日単位のまま。週間・月間ビューは日データを束ねて見せるだけなので、
   ビューを切り替えても保存されている工程は変わらない。 */
const VIEW_MODES = ["day", "week", "month"];
let viewMode = loadViewMode();

function loadViewMode() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEW_MODES.includes(v) ? v : "day";
  } catch (e) { return "day"; }
}

function setViewMode(mode) {
  if (!VIEW_MODES.includes(mode) || mode === viewMode) return;
  viewMode = mode;
  try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* ignore */ }
  renderViewSwitch();
  renderGantt();
}

function renderViewSwitch() {
  $$(".view-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.view === viewMode);
  });
}

function bindViewSwitch() {
  $$(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => setViewMode(btn.dataset.view));
  });
  renderViewSwitch();
}

/* ---------------- 表示期間の絞り込み ----------------
   「9月だけ」「9/1〜9/15だけ」のように、工期の一部を取り出して表示・印刷する。
   絞り込んでも工程データには一切触らないので、全期間に戻せば元通り。 */
let viewRange = loadViewRange();

function loadViewRange() {
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (r && typeof r.from === "string" && typeof r.to === "string") return r;
  } catch (e) { /* ignore */ }
  return null;
}

function saveViewRange() {
  try {
    if (viewRange) localStorage.setItem(RANGE_KEY, JSON.stringify(viewRange));
    else localStorage.removeItem(RANGE_KEY);
  } catch (e) { /* ignore */ }
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
  if (!fromEl || !toEl) return;

  const r = effectiveRange();
  if (document.activeElement !== fromEl) fromEl.value = viewRange ? viewRange.from : (state.meta.startDate || "");
  if (document.activeElement !== toEl) toEl.value = viewRange ? viewRange.to : (state.meta.endDate || "");

  const sel = $("#range-month");
  if (sel && document.activeElement !== sel) {
    const want = wholeMonthKey(viewRange);
    sel.innerHTML = "";
    const head = document.createElement("option");
    head.value = "";
    head.textContent = "月を選ぶ";
    sel.appendChild(head);
    monthListBetween(state.meta.startDate, state.meta.endDate).forEach((mo) => {
      const o = document.createElement("option");
      o.value = mo.key;
      o.textContent = mo.label;
      sel.appendChild(o);
    });
    sel.value = Array.from(sel.options).some((o) => o.value === want) ? want : "";
  }

  const active = !!viewRange;
  const wrap = $(".gantt-wrap");
  if (wrap) wrap.classList.toggle("range-active", active);

  const clear = $("#range-clear");
  if (clear) clear.disabled = !active;

  const caption = $("#range-caption");
  if (!caption) return;
  if (!active) {
    caption.hidden = true;
    caption.textContent = "";
    return;
  }
  const shown = dateRangeArray(r.from, r.to).length;
  const total = dateRangeArray(state.meta.startDate, state.meta.endDate).length;
  caption.hidden = false;
  if (!shown) {
    caption.className = "range-caption range-caption-warn";
    caption.textContent =
      `指定した期間（${formatJP(viewRange.from)}〜${formatJP(viewRange.to)}）は工期の外です。`;
  } else {
    caption.className = "range-caption";
    caption.textContent =
      `表示期間：${formatJP(r.from)} 〜 ${formatJP(r.to)}（全${total}日のうち${shown}日ぶんを表示中）`;
  }
}

function bindRangeFilter() {
  const fromEl = $("#range-from");
  const toEl = $("#range-to");
  if (!fromEl || !toEl) return;

  const applyNow = () => {
    if (!fromEl.value || !toEl.value) return;
    setViewRange(fromEl.value, toEl.value);
  };
  [fromEl, toEl].forEach((el) => el.addEventListener("change", applyNow));

  const sel = $("#range-month");
  if (sel) {
    sel.addEventListener("change", () => {
      if (!sel.value) { clearViewRange(); return; }
      const [y, m] = sel.value.split("-").map(Number);
      setViewRange(
        isoDate(new Date(y, m - 1, 1, 12, 0, 0)),
        isoDate(new Date(y, m, 0, 12, 0, 0))
      );
    });
  }

  const clear = $("#range-clear");
  if (clear) clear.addEventListener("click", clearViewRange);

  renderRangeUI();
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
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}

function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedIds])); } catch (e) { /* ignore */ }
}

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

/* ---------------- rendering: gantt ---------------- */
let colList = [];

function renderGantt() {
  colList = buildColumns();
  const table = $("#gantt-table");
  const thead = $("#gantt-thead");
  const tbody = $("#gantt-tbody");
  table.className = "view-" + viewMode;
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const groupRow = document.createElement("tr");
  const labelTh0 = document.createElement("th");
  labelTh0.className = "th-label";
  labelTh0.rowSpan = 3;
  labelTh0.textContent = "項　目";
  groupRow.appendChild(labelTh0);

  let i = 0;
  while (i < colList.length) {
    const key = colList[i].groupKey;
    let span = 0;
    while (i + span < colList.length && colList[i + span].groupKey === key) span++;
    const th = document.createElement("th");
    th.className = "th-month";
    th.colSpan = span;
    th.textContent = colList[i].groupLabel;
    groupRow.appendChild(th);
    i += span;
  }
  thead.appendChild(groupRow);

  const topRow = document.createElement("tr");
  const bottomRow = document.createElement("tr");
  colList.forEach((col) => {
    const th = document.createElement("th");
    th.className = "th-day day-col" + col.cls;
    th.textContent = col.top;
    topRow.appendChild(th);

    const bth = document.createElement("th");
    bth.className = "th-weekday day-col" + col.cls;
    bth.textContent = col.bottom;
    bottomRow.appendChild(bth);
  });
  thead.appendChild(topRow);
  thead.appendChild(bottomRow);

  visibleRows().forEach((row) => {
    tbody.appendChild(buildItemRow(row));
  });
}

function weekendClass(d) {
  if (d.getDay() === 6) return " td-sat";
  if (d.getDay() === 0) return " td-sun";
  return "";
}

/* ---------------- 行のドラッグ並べ替え ---------------- */
let rowDrag = null;

function startRowDrag(ev, itemId, tr) {
  if (!editMode) return;
  if (ev.button !== undefined && ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const tbody = document.getElementById("gantt-tbody");
  if (!tbody) return;

  rowDrag = { itemId, tr, tbody, fromIndex: Array.from(tbody.children).indexOf(tr) };
  tr.classList.add("row-dragging");
  document.body.classList.add("row-drag-active");
  window.addEventListener("pointermove", onRowDragMove);
  window.addEventListener("pointerup", endRowDrag);
  window.addEventListener("pointercancel", cancelRowDrag);
}

// 行を実際にDOM上で動かしながらプレビューする。確定は pointerup。
function onRowDragMove(ev) {
  if (!rowDrag) return;
  ev.preventDefault();
  const { tr, tbody } = rowDrag;
  const rows = Array.from(tbody.children);
  const y = ev.clientY;

  for (const row of rows) {
    if (row === tr) continue;
    const rect = row.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      if (y < rect.top + rect.height / 2) tbody.insertBefore(tr, row);
      else tbody.insertBefore(tr, row.nextSibling);
      return;
    }
  }

  // 一番上／一番下からはみ出した場合
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && y < first.getBoundingClientRect().top) tbody.insertBefore(tr, first);
  else if (last && y > last.getBoundingClientRect().bottom) tbody.appendChild(tr);
}

function finishRowDrag() {
  window.removeEventListener("pointermove", onRowDragMove);
  window.removeEventListener("pointerup", endRowDrag);
  window.removeEventListener("pointercancel", cancelRowDrag);
  if (rowDrag) rowDrag.tr.classList.remove("row-dragging");
  document.body.classList.remove("row-drag-active");
  const ctx = rowDrag;
  rowDrag = null;
  return ctx;
}

function endRowDrag() {
  const ctx = finishRowDrag();
  if (!ctx) return;
  const domRows = Array.from(ctx.tbody.children);
  const domIndex = domRows.indexOf(ctx.tr);
  if (domIndex < 0 || domIndex === ctx.fromIndex) {
    renderGantt(); // 動かなかった場合もDOMを状態に戻す
    return;
  }
  const toIndex = dropIndexInState(ctx.itemId, domRows, domIndex);
  if (toIndex === null) {
    renderGantt();
    return;
  }
  dispatchLocal({ type: "reorderItem", itemId: ctx.itemId, toIndex });
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

function buildItemRow(row) {
  // 旧データ対策：level / cells / labels が無くても描画できるようにする
  const item = row.item;
  const level = row.level;
  const cells = item.cells && typeof item.cells === "object" ? item.cells : {};
  const labels = item.labels && typeof item.labels === "object" ? item.labels : {};

  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;
  if (row.collapsed) tr.classList.add("row-collapsed");

  const labelTd = document.createElement("td");
  labelTd.className = "td-label lv" + level;
  const inner = document.createElement("div");
  inner.className = "item-row-inner";

  const dragHandle = document.createElement("span");
  dragHandle.className = "row-drag";
  dragHandle.textContent = "⠿";
  dragHandle.title = "ドラッグで並べ替え";
  dragHandle.addEventListener("pointerdown", (e) => startRowDrag(e, item.id, tr));

  // 折りたたみは見え方の操作なので、閲覧のみモードでも押せるようにしておく
  const twisty = document.createElement("button");
  twisty.className = "row-twisty";
  if (row.hasChildren) {
    twisty.textContent = row.collapsed ? "▶" : "▼";
    twisty.title = row.collapsed ? "この工種の中を表示する" : "この工種の中を折りたたむ（印刷にも出なくなります）";
    twisty.addEventListener("click", () => toggleCollapse(item.id));
  } else {
    twisty.classList.add("row-twisty-empty");
    twisty.textContent = "";
    twisty.tabIndex = -1;
    twisty.setAttribute("aria-hidden", "true");
  }

  const nameInput = document.createElement("input");
  nameInput.className = "item-name-input" + (item.bold ? " bold" : "");
  nameInput.style.paddingLeft = (2 + level * 14) + "px";
  nameInput.value = item.name;
  nameInput.readOnly = !editMode;
  nameInput.addEventListener("change", (e) => {
    dispatchLocal({ type: "renameItem", itemId: item.id, name: e.target.value });
  });
  nameInput.addEventListener("dblclick", () => {
    dispatchLocal({ type: "toggleBold", itemId: item.id });
  });

  const outBtn = document.createElement("button");
  outBtn.className = "row-btn";
  outBtn.textContent = "◀";
  outBtn.title = "階層を上げる";
  outBtn.addEventListener("click", () => {
    if (level > 0) dispatchLocal({ type: "setLevel", itemId: item.id, level: level - 1 });
  });

  const inBtn = document.createElement("button");
  inBtn.className = "row-btn";
  inBtn.textContent = "▶";
  inBtn.title = "階層を下げる（子工種にする）";
  inBtn.addEventListener("click", () => {
    if (level < MAX_LEVEL) dispatchLocal({ type: "setLevel", itemId: item.id, level: level + 1 });
  });

  const delBtn = document.createElement("button");
  delBtn.className = "row-btn";
  delBtn.textContent = "✕";
  delBtn.title = "削除";
  delBtn.addEventListener("click", () => {
    if (!confirm("この工種を削除しますか？")) return;
    dispatchLocal({ type: "removeItem", itemId: item.id });
  });

  [outBtn, inBtn, delBtn].forEach((b) => { b.disabled = !editMode; });

  inner.appendChild(dragHandle);
  inner.appendChild(twisty);
  inner.appendChild(nameInput);
  inner.appendChild(outBtn);
  inner.appendChild(inBtn);
  inner.appendChild(delBtn);
  labelTd.appendChild(inner);
  tr.appendChild(labelTd);

  colList.forEach((col) => {
    const td = document.createElement("td");
    td.className = "gantt-cell day-col" + col.cls;
    td.dataset.itemId = item.id;
    td.dataset.date = col.days[0];
    td.dataset.colKey = col.key;
    const bg = bucketBackground(cells, col.days);
    if (bg) td.style.background = bg;
    // 週間・月間ビューでは、その期間に付いている作業名を代表して1つ出す
    const labelIso = col.days.find((iso) => labels[iso]);
    if (labelIso) renderCellLabel(td, labels[labelIso]);
    tr.appendChild(td);
  });

  return tr;
}

function applyToolToCell(td) {
  const itemId = td.dataset.itemId;
  const item = state.items.find((it) => it.id === itemId);
  if (!item) return;
  const days = cellDays(td);
  if (!days.length) return;
  const cells = item.cells && typeof item.cells === "object" ? item.cells : {};
  const from = days[0];
  const to = days[days.length - 1];

  // 日別ビューは従来どおり1日ぶんのop。週間・月間ビューはその期間をまとめて1opにする
  // （7日ぶん・31日ぶんのopを撒かずに済むので、opログが必要以上に増えない）。
  if (paintMode === "erase") {
    if (days.every((iso) => cells[iso] === undefined)) return;
    if (days.length === 1) dispatchLocal({ type: "erase", itemId, date: from });
    else dispatchLocal({ type: "eraseRange", itemId, from, to });
  } else {
    if (days.every((iso) => cells[iso] === currentTool.value)) return;
    if (days.length === 1) dispatchLocal({ type: "paint", itemId, date: from, color: currentTool.value });
    else dispatchLocal({ type: "paintRange", itemId, from, to, color: currentTool.value });
  }
}

let labelEditorEl = null;

function closeLabelEditor() {
  const el = labelEditorEl;
  labelEditorEl = null;
  // Enter確定とblurが続けて走った時に二重removeで例外にならないようにする
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function openLabelEditor(td) {
  if (!editMode) return;
  const itemId = td.dataset.itemId;
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;
  const days = cellDays(td);
  if (!days.length) return;
  // 週間・月間ビューでは、その期間に既にある作業名を編集する（無ければ期間の先頭に付ける）
  const date = days.find((iso) => (item.labels || {})[iso]) || days[0];
  closeLabelEditor();

  const rect = td.getBoundingClientRect();
  const input = document.createElement("input");
  input.className = "label-editor";
  input.placeholder = "作業内容を入力（例：既存護岸取壊し）";
  input.value = (item.labels || {})[date] || "";
  input.style.left = (rect.left + window.scrollX) + "px";
  input.style.top = (rect.top + window.scrollY) + "px";
  document.body.appendChild(input);
  labelEditorEl = input;
  input.focus();
  input.select();

  const commit = () => {
    if (!labelEditorEl) return;
    const text = input.value.trim();
    closeLabelEditor();
    if (((item.labels || {})[date] || "") !== text) {
      dispatchLocal({ type: "setLabel", itemId, date, text });
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeLabelEditor(); }
  });
  input.addEventListener("blur", commit);
}

function bindGanttPainting() {
  const scroll = $("#gantt-scroll");
  scroll.addEventListener("mousedown", (e) => {
    if (!editMode) return;
    const td = e.target.closest(".gantt-cell");
    if (!td) return;
    e.preventDefault();
    if (currentTool.type === "label") { openLabelEditor(td); return; }
    painting = true;
    paintMode = currentTool.type === "erase" ? "erase" : "paint";
    applyToolToCell(td);
  });
  scroll.addEventListener("mouseover", (e) => {
    if (!painting) return;
    const td = e.target.closest(".gantt-cell");
    if (!td) return;
    applyToolToCell(td);
  });
  document.addEventListener("mouseup", () => { painting = false; });

  scroll.addEventListener("touchstart", (e) => {
    if (!editMode) return;
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const td = el && el.closest(".gantt-cell");
    if (!td) return;
    if (currentTool.type === "label") { openLabelEditor(td); return; }
    painting = true;
    paintMode = currentTool.type === "erase" ? "erase" : "paint";
    applyToolToCell(td);
  }, { passive: true });
  scroll.addEventListener("touchmove", (e) => {
    if (!painting) return;
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const td = el && el.closest(".gantt-cell");
    if (!td) return;
    applyToolToCell(td);
  }, { passive: true });
  scroll.addEventListener("touchend", () => { painting = false; });
}

function addItem() {
  const last = state.items[state.items.length - 1];
  dispatchLocal({
    type: "addItem",
    item: { id: uid(), name: "新規工種", bold: false, level: last ? last.level : 0, cells: {}, labels: {} }
  });
}

/* ---------------- 印刷レイアウト ----------------
   画面の表をそのまま印刷すると、工種が多いときに「基本情報 → 工程表の上半分 →
   工程表の下半分」と縦に切れてしまい読めない。そこで印刷時は専用のDOMを組み直し、
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

function buildPrintLayout() {
  const root = document.getElementById("print-root");
  if (!root) return;
  root.innerHTML = "";

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
  const colW = Math.min(gridW / perPage, P.colPref[viewMode]);

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
      root.appendChild(buildPrintPage(band, cc, colW, rowH, n, total));
    });
  });

  const progressPage = buildProgressPage();
  if (progressPage) root.appendChild(progressPage);
}

function clearPrintLayout() {
  const root = document.getElementById("print-root");
  if (root) root.innerHTML = "";
  document.body.classList.remove("printing");
}

function buildPrintHead(cols, pageNo, pageTotal) {
  const m = state.meta;
  const head = document.createElement("div");
  head.className = "print-head";

  const title = document.createElement("div");
  title.className = "print-title";
  title.textContent = "工 事 工 程 表";
  head.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "print-meta";
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
    const cell = document.createElement("div");
    cell.className = "print-meta-item";
    const key = document.createElement("span");
    key.className = "print-meta-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "print-meta-val";
    val.textContent = v || "";
    cell.appendChild(key);
    cell.appendChild(val);
    grid.appendChild(cell);
  });
  head.appendChild(grid);

  const sub = document.createElement("div");
  sub.className = "print-subhead";
  const first = cols[0];
  const last = cols[cols.length - 1];
  const span = document.createElement("span");
  span.textContent = `この紙の期間：${formatJP(first.days[0])} 〜 ${formatJP(last.days[last.days.length - 1])}`;
  const pno = document.createElement("span");
  pno.textContent = `${pageNo} / ${pageTotal}`;
  sub.appendChild(span);
  sub.appendChild(pno);
  head.appendChild(sub);

  return head;
}

function buildPrintPage(rows, cols, colW, rowH, pageNo, pageTotal) {
  const P = PRINT_MM;
  const page = document.createElement("section");
  page.className = "print-page";
  page.appendChild(buildPrintHead(cols, pageNo, pageTotal));

  const table = document.createElement("table");
  table.className = "print-table";
  table.style.fontSize = Math.max(5, Math.min(8, rowH * 1.15)).toFixed(2) + "pt";

  const colgroup = document.createElement("colgroup");
  const firstCol = document.createElement("col");
  firstCol.style.width = P.labelW + "mm";
  colgroup.appendChild(firstCol);
  cols.forEach(() => {
    const c = document.createElement("col");
    c.style.width = colW.toFixed(3) + "mm";
    colgroup.appendChild(c);
  });
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const groupRow = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.className = "p-th p-label";
  th0.rowSpan = 3;
  th0.textContent = "項　目";
  groupRow.appendChild(th0);
  let i = 0;
  while (i < cols.length) {
    const key = cols[i].groupKey;
    let span = 0;
    while (i + span < cols.length && cols[i + span].groupKey === key) span++;
    const th = document.createElement("th");
    th.className = "p-th p-month";
    th.colSpan = span;
    th.textContent = cols[i].groupLabel;
    groupRow.appendChild(th);
    i += span;
  }
  thead.appendChild(groupRow);

  const topRow = document.createElement("tr");
  const botRow = document.createElement("tr");
  cols.forEach((col) => {
    const a = document.createElement("th");
    a.className = "p-th" + col.cls;
    a.textContent = col.top;
    topRow.appendChild(a);
    const b = document.createElement("th");
    b.className = "p-th" + col.cls;
    b.textContent = col.bottom;
    botRow.appendChild(b);
  });
  thead.appendChild(topRow);
  thead.appendChild(botRow);
  // 見出しの高さを決め打ちにして、本体の行数計算とズレないようにする
  const headRowH = (P.theadH / 3).toFixed(3) + "mm";
  [groupRow, topRow, botRow].forEach((tr) => { tr.style.height = headRowH; });
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const item = row.item;
    const cells = item.cells && typeof item.cells === "object" ? item.cells : {};
    const labels = item.labels && typeof item.labels === "object" ? item.labels : {};

    const tr = document.createElement("tr");
    tr.style.height = rowH.toFixed(3) + "mm";

    const nameTd = document.createElement("td");
    nameTd.className = "p-label lv" + row.level + (item.bold ? " p-bold" : "");
    nameTd.style.paddingLeft = (1.5 + row.level * 3).toFixed(2) + "mm";
    // 折りたたんだ親は、中に隠れている行があることが紙面でも分かるようにする
    nameTd.textContent = (row.collapsed ? "▶ " : "") + (item.name || "");
    tr.appendChild(nameTd);

    cols.forEach((col) => {
      const td = document.createElement("td");
      td.className = "p-cell" + col.cls;
      const bg = bucketBackground(cells, col.days);
      if (bg) td.style.background = bg;
      const iso = col.days.find((d) => labels[d]);
      if (iso) {
        const span = document.createElement("span");
        span.className = "p-bar-label";
        span.textContent = labels[iso];
        td.appendChild(span);
      }
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

  const page = document.createElement("section");
  page.className = "print-page print-page-progress";

  const title = document.createElement("div");
  title.className = "print-title";
  title.textContent = "出 来 高 率（S字カーブ）";
  page.appendChild(title);

  const table = document.createElement("table");
  table.className = "print-progress-table";
  const head = document.createElement("tr");
  head.appendChild(printTh("月"));
  months.forEach((mo) => head.appendChild(printTh(mo.label)));
  table.appendChild(head);

  [["計 画 (%)", "plan"], ["実 績 (%)", "actual"]].forEach(([label, kind]) => {
    const tr = document.createElement("tr");
    tr.appendChild(printTh(label));
    months.forEach((mo) => {
      const td = document.createElement("td");
      const v = state.progress && state.progress[kind] ? state.progress[kind][mo.key] : null;
      td.textContent = (v === undefined || v === null || v === "") ? "" : String(v);
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  page.appendChild(table);

  // 画面で描いてあるグラフをそのまま画像として貼る
  const canvas = document.getElementById("progress-canvas");
  if (canvas) {
    try {
      const img = document.createElement("img");
      img.className = "print-chart";
      img.src = canvas.toDataURL("image/png");
      page.appendChild(img);
    } catch (e) { /* 画像化できない環境ではグラフ無しで印刷する */ }
  }

  return page;
}

function printTh(text) {
  const th = document.createElement("th");
  th.textContent = text;
  return th;
}

function doPrint() {
  document.body.classList.add("printing");
  buildPrintLayout();
  window.print();
}

/* ---------------- rendering: progress / S-curve ---------------- */
function renderProgress() {
  const months = monthListBetween(state.meta.startDate, state.meta.endDate);
  const table = $("#progress-table");
  table.innerHTML = "";

  const headRow = document.createElement("tr");
  headRow.appendChild(makeTh("月"));
  months.forEach((mo) => headRow.appendChild(makeTh(mo.label)));
  table.appendChild(headRow);

  function buildRow(labelText, kind) {
    const row = document.createElement("tr");
    row.appendChild(makeTh(labelText));
    months.forEach((mo) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.max = "100";
      input.dataset.kind = kind;
      input.dataset.month = mo.key;
      input.value = state.progress[kind][mo.key] ?? "";
      input.disabled = !editMode;
      input.addEventListener("input", (e) => {
        const value = e.target.value === "" ? null : Number(e.target.value);
        dispatchLocal({ type: "setProgress", kind, monthKey: mo.key, value });
      });
      td.appendChild(input);
      row.appendChild(td);
    });
    table.appendChild(row);
  }

  buildRow("計画(%)", "plan");
  buildRow("実績(%)", "actual");

  drawChart(months);
}

function makeTh(text) {
  const th = document.createElement("th");
  th.textContent = text;
  return th;
}

function drawChart(months) {
  const canvas = $("#progress-canvas");
  const ctx = canvas.getContext("2d");
  const w = Math.max(900, months.length * 70 + 80);
  canvas.width = w;
  const H = canvas.height;
  const padL = 40, padR = 20, padT = 20, padB = 30;
  const plotW = w - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, w, H);

  ctx.strokeStyle = "#ddd";
  ctx.fillStyle = "#666";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  for (let p = 0; p <= 100; p += 25) {
    const y = padT + plotH * (1 - p / 100);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(p + "%", padL - 6, y + 4);
  }

  if (months.length === 0) return;
  const stepX = months.length > 1 ? plotW / (months.length - 1) : 0;

  ctx.textAlign = "center";
  months.forEach((mo, idx) => {
    const x = padL + stepX * idx;
    ctx.fillStyle = "#555";
    ctx.fillText(mo.label.replace("年", "/").replace("月", ""), x, H - padB + 16);
  });

  function plotLine(key, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    months.forEach((mo, idx) => {
      const val = state.progress[key][mo.key];
      if (val === undefined || val === null || val === "") return;
      const x = padL + stepX * idx;
      const y = padT + plotH * (1 - Math.max(0, Math.min(100, val)) / 100);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    months.forEach((mo, idx) => {
      const val = state.progress[key][mo.key];
      if (val === undefined || val === null || val === "") return;
      const x = padL + stepX * idx;
      const y = padT + plotH * (1 - Math.max(0, Math.min(100, val)) / 100);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  plotLine("plan", "#d64545");
  plotLine("actual", "#2f6fed");

  ctx.textAlign = "left";
  ctx.fillStyle = "#d64545";
  ctx.fillText("● 計画", padL, 14);
  ctx.fillStyle = "#2f6fed";
  ctx.fillText("● 実績", padL + 60, 14);
}

/* ---------------- toolbar / palette ---------------- */
function renderPalette() {
  const el = $("#palette");
  el.innerHTML = "";
  PALETTE.forEach((color, idx) => {
    const btn = document.createElement("button");
    btn.className = "swatch" + (idx === 0 ? " selected" : "");
    btn.style.background = color;
    btn.addEventListener("click", () => selectColor(color, btn));
    el.appendChild(btn);
  });
}

function setTool(tool, btnEl) {
  currentTool = tool;
  $$(".swatch").forEach((s) => s.classList.remove("selected"));
  $$(".tool-btn").forEach((b) => b.classList.remove("selected"));
  if (btnEl) btnEl.classList.add("selected");
}

function selectColor(color, btnEl) {
  setTool({ type: "color", value: color }, btnEl);
}

function bindToolbar() {
  $("#btn-add-item").addEventListener("click", addItem);
  $("#btn-add-item-bottom").addEventListener("click", addItem);
  $("#btn-print").addEventListener("click", doPrint);
  // Ctrl+P など、ボタン以外から印刷された時も同じ紙面になるようにする
  window.addEventListener("beforeprint", () => {
    document.body.classList.add("printing");
    buildPrintLayout();
  });
  window.addEventListener("afterprint", clearPrintLayout);

  $("#btn-excel").addEventListener("click", () => {
    try {
      window.KouteiXlsx.exportSchedule(state);
      showShareStatus("Excelファイルを出力しました");
    } catch (e) {
      alert("Excel出力に失敗しました：" + e.message);
    }
  });

  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.meta.projectName || "工事工程表") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const normalized = normalizeState(parsed);
        dispatchLocal({ type: "resetAll", state: normalized });
      } catch (err) {
        alert("JSONファイルの読み込みに失敗しました。");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  $("#btn-share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showShareStatus("共有URLをコピーしました");
    } catch (e) {
      showShareStatus("コピーに失敗しました。アドレスバーのURLを共有してください");
    }
  });

  $("#tool-erase").addEventListener("click", (e) => {
    setTool({ type: "erase", value: null }, e.currentTarget);
  });

  $("#tool-label").addEventListener("click", (e) => {
    setTool({ type: "label", value: null }, e.currentTarget);
  });

  $("#custom-color").addEventListener("input", (e) => {
    selectColor(e.target.value, null);
  });
}

let shareStatusTimer = null;
function showShareStatus(msg) {
  const el = $("#share-status");
  el.textContent = msg;
  clearTimeout(shareStatusTimer);
  shareStatusTimer = setTimeout(() => { el.textContent = ""; }, 3000);
}

/* ---------------- normalize / migrate ---------------- */
function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    meta: Object.assign(base.meta, raw.meta || {}),
    items: Array.isArray(raw.items) && raw.items.length
      ? raw.items.map(normalizeItem)
      : base.items,
    progress: {
      plan: (raw.progress && raw.progress.plan) || {},
      actual: (raw.progress && raw.progress.actual) || {}
    }
  };
}

/* ---------------- utils ---------------- */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

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

  renderPalette();
  bindHeaderEvents();
  bindGanttPainting();
  bindToolbar();
  bindViewSwitch();
  bindRangeFilter();
  bindEditMode();
  renderAll();
  saveLocal();

  startSync();
}

init();
})();
