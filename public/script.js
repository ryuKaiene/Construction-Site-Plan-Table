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
    dispatchLocal({ type: "resetAll", state });
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

function dispatchLocal(op) {
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
    if (el) el.value = m[key] || "";
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

/* 1列ぶんの情報を作る。days にはその列がまとめている日（工期内のみ）が入る。
   groupKey が同じ列は、ヘッダの1段目でひとまとめにされる。 */
function buildColumns() {
  const days = dateRangeArray(state.meta.startDate, state.meta.endDate);
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

  state.items.forEach((item) => {
    tbody.appendChild(buildItemRow(item));
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
  const toIndex = Array.from(ctx.tbody.children).indexOf(ctx.tr);
  if (toIndex < 0 || toIndex === ctx.fromIndex) {
    renderGantt(); // 動かなかった場合もDOMを状態に戻す
    return;
  }
  dispatchLocal({ type: "reorderItem", itemId: ctx.itemId, toIndex });
}

function cancelRowDrag() {
  if (finishRowDrag()) renderGantt();
}

function buildItemRow(item) {
  // 旧データ対策：level / cells / labels が無くても描画できるようにする
  const level = Math.max(0, Math.min(MAX_LEVEL, Number(item.level) || 0));
  const cells = item.cells && typeof item.cells === "object" ? item.cells : {};
  const labels = item.labels && typeof item.labels === "object" ? item.labels : {};

  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;

  const labelTd = document.createElement("td");
  labelTd.className = "td-label lv" + level;
  const inner = document.createElement("div");
  inner.className = "item-row-inner";

  const dragHandle = document.createElement("span");
  dragHandle.className = "row-drag";
  dragHandle.textContent = "⠿";
  dragHandle.title = "ドラッグで並べ替え";
  dragHandle.addEventListener("pointerdown", (e) => startRowDrag(e, item.id, tr));

  const nameInput = document.createElement("input");
  nameInput.className = "item-name-input" + (item.bold ? " bold" : "");
  nameInput.style.paddingLeft = (2 + level * 14) + "px";
  nameInput.value = item.name;
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

  const upBtn = document.createElement("button");
  upBtn.className = "row-btn";
  upBtn.textContent = "▲";
  upBtn.title = "上へ移動";
  upBtn.addEventListener("click", () => dispatchLocal({ type: "moveItem", itemId: item.id, dir: -1 }));

  const downBtn = document.createElement("button");
  downBtn.className = "row-btn";
  downBtn.textContent = "▼";
  downBtn.title = "下へ移動";
  downBtn.addEventListener("click", () => dispatchLocal({ type: "moveItem", itemId: item.id, dir: 1 }));

  const delBtn = document.createElement("button");
  delBtn.className = "row-btn";
  delBtn.textContent = "✕";
  delBtn.title = "削除";
  delBtn.addEventListener("click", () => {
    if (!confirm("この工種を削除しますか？")) return;
    dispatchLocal({ type: "removeItem", itemId: item.id });
  });

  inner.appendChild(dragHandle);
  inner.appendChild(nameInput);
  inner.appendChild(outBtn);
  inner.appendChild(inBtn);
  inner.appendChild(upBtn);
  inner.appendChild(downBtn);
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
  $("#btn-print").addEventListener("click", () => window.print());

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
  renderAll();
  saveLocal();

  startSync();
}

init();
})();
