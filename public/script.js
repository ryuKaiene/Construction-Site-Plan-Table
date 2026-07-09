(() => {
"use strict";

const STORAGE_KEY = "koutei-hyou-state-v1";
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
const PALETTE = [
  "#4f8ef7", "#f76c6c", "#f7b84f", "#4fd17f", "#a678f2",
  "#f76ccb", "#2ecfcf", "#8a8f98", "#e0c34f", "#222222"
];
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

/* ---------------- default state (seeded from actual project) ---------------- */
function defaultState() {
  return {
    meta: {
      projectName: "６災１１２２号　二級河川松波川　河川災害復旧工事（その１）（概略発注対象工事）",
      orderer: "石川県土木部",
      location: "鳳珠郡能登町字松波地内",
      supervisor: "",
      contractor: "株式会社 西中建設",
      contractDate: "2025-03-19",
      createdDate: isoDate(new Date()),
      startDate: "2026-07-01",
      endDate: "2027-03-26"
    },
    items: [
      { id: uid(), name: "河川土工", bold: false, cells: {} },
      { id: uid(), name: "護岸工", bold: false, cells: {} },
      { id: uid(), name: "擁壁護岸工", bold: false, cells: {} },
      { id: uid(), name: "付帯道路工", bold: false, cells: {} },
      { id: uid(), name: "構造物撤去工", bold: false, cells: {} },
      { id: uid(), name: "仮設工", bold: false, cells: {} }
    ],
    progress: { plan: {}, actual: {} }
  };
}

let state = null;
let currentTool = { type: "color", value: PALETTE[0] };
let painting = false;
let paintMode = null; // 'paint' | 'erase'

/* ---------------- realtime sync (HTTP polling against D1-backed op log) ---------------- */
const roomId = new URLSearchParams(location.search).get("room") || "default";
const LASTSEQ_KEY = "koutei-hyou-lastseq-v1";
const POLL_INTERVAL_MS = 2000;
const BATCH_LIMIT = 500;

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
  try {
    let more = true;
    while (more) {
      const res = await fetch(`/api/ops?room=${encodeURIComponent(roomId)}&since=${lastSeq}`);
      if (!res.ok) throw new Error("poll failed");
      const data = await res.json();
      for (const { seq, op } of data.ops) {
        if (!appliedSeqs.has(seq)) {
          receiveRemoteOp(op);
          appliedSeqs.add(seq);
        }
        if (seq > lastSeq) lastSeq = seq;
      }
      more = data.ops.length === BATCH_LIMIT;
    }
    saveLastSeq();
    setConnStatus("online");
    return true;
  } catch (e) {
    setConnStatus("offline");
    return false;
  }
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
      if (item) delete item.cells[op.date];
      break;
    }
    case "addItem":
      state.items.push(op.item);
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
    case "erase": {
      const td = document.querySelector(
        `.gantt-cell[data-item-id="${cssEscape(op.itemId)}"][data-date="${op.date}"]`
      );
      if (td) td.style.background = op.type === "paint" ? op.color : "";
      break;
    }
    case "addItem":
    case "removeItem":
    case "moveItem":
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

function dispatchLocal(op) {
  applyOp(op);
  renderForOp(op);
  saveLocal();
  scheduleHashUpdate();
  syncPush(op);
}

function receiveRemoteOp(op) {
  applyOp(op);
  renderForOp(op);
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

function textToBase64Url(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToText(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return decodeURIComponent(escape(atob(b64)));
}

async function encodeStateForHash(s) {
  const json = JSON.stringify(s);
  if (window.CompressionStream) {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
      const buf = await new Response(stream).arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return "z" + b64;
    } catch (e) { /* fall through to plain */ }
  }
  return "p" + textToBase64Url(json);
}

async function decodeStateFromHash(hash) {
  if (!hash) return null;
  const tag = hash[0];
  const body = hash.slice(1);
  try {
    if (tag === "z" && window.DecompressionStream) {
      let b64 = body.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const buf = await new Response(stream).arrayBuffer();
      const json = new TextDecoder().decode(buf);
      return JSON.parse(json);
    }
    if (tag === "p") {
      return JSON.parse(base64UrlToText(body));
    }
  } catch (e) { return null; }
  return null;
}

let hashUpdateTimer = null;
function scheduleHashUpdate() {
  clearTimeout(hashUpdateTimer);
  hashUpdateTimer = setTimeout(async () => {
    const encoded = await encodeStateForHash(state);
    history.replaceState(null, "", location.pathname + location.search + "#" + encoded);
  }, 400);
}

/* ---------------- rendering: header ---------------- */
function renderHeader() {
  const m = state.meta;
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.value = m[key] || "";
  });
}

function bindHeaderEvents() {
  Object.entries(META_INPUT_ID).forEach(([key, id]) => {
    document.getElementById(id).addEventListener("change", (e) => {
      dispatchLocal({ type: "setMeta", key, value: e.target.value });
    });
  });
}

/* ---------------- rendering: gantt ---------------- */
let dayList = [];

function renderGantt() {
  dayList = dateRangeArray(state.meta.startDate, state.meta.endDate);
  const thead = $("#gantt-thead");
  const tbody = $("#gantt-tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const monthRow = document.createElement("tr");
  const labelTh0 = document.createElement("th");
  labelTh0.className = "th-label";
  labelTh0.rowSpan = 3;
  labelTh0.textContent = "項　目";
  monthRow.appendChild(labelTh0);

  let i = 0;
  while (i < dayList.length) {
    const d = dayList[i];
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    let span = 0;
    while (i + span < dayList.length) {
      const dd = dayList[i + span];
      if (`${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}` !== key) break;
      span++;
    }
    const th = document.createElement("th");
    th.className = "th-month";
    th.colSpan = span;
    th.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    monthRow.appendChild(th);
    i += span;
  }
  thead.appendChild(monthRow);

  const dayRow = document.createElement("tr");
  const weekdayRow = document.createElement("tr");
  dayList.forEach((d) => {
    const th = document.createElement("th");
    th.className = "th-day day-col" + weekendClass(d);
    th.textContent = String(d.getDate());
    dayRow.appendChild(th);

    const wth = document.createElement("th");
    wth.className = "th-weekday day-col" + weekendClass(d);
    wth.textContent = WEEKDAY_JP[d.getDay()];
    weekdayRow.appendChild(wth);
  });
  thead.appendChild(dayRow);
  thead.appendChild(weekdayRow);

  state.items.forEach((item) => {
    tbody.appendChild(buildItemRow(item));
  });
}

function weekendClass(d) {
  if (d.getDay() === 6) return " td-sat";
  if (d.getDay() === 0) return " td-sun";
  return "";
}

function buildItemRow(item) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;

  const labelTd = document.createElement("td");
  labelTd.className = "td-label";
  const inner = document.createElement("div");
  inner.className = "item-row-inner";

  const nameInput = document.createElement("input");
  nameInput.className = "item-name-input" + (item.bold ? " bold" : "");
  nameInput.value = item.name;
  nameInput.addEventListener("change", (e) => {
    dispatchLocal({ type: "renameItem", itemId: item.id, name: e.target.value });
  });
  nameInput.addEventListener("dblclick", () => {
    dispatchLocal({ type: "toggleBold", itemId: item.id });
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

  inner.appendChild(nameInput);
  inner.appendChild(upBtn);
  inner.appendChild(downBtn);
  inner.appendChild(delBtn);
  labelTd.appendChild(inner);
  tr.appendChild(labelTd);

  dayList.forEach((d) => {
    const iso = isoDate(d);
    const td = document.createElement("td");
    td.className = "gantt-cell day-col" + weekendClass(d);
    td.dataset.itemId = item.id;
    td.dataset.date = iso;
    const color = item.cells[iso];
    if (color) td.style.background = color;
    tr.appendChild(td);
  });

  return tr;
}

function applyToolToCell(td) {
  const itemId = td.dataset.itemId;
  const date = td.dataset.date;
  const item = state.items.find((it) => it.id === itemId);
  if (!item) return;
  if (paintMode === "erase") {
    if (item.cells[date] === undefined) return;
    dispatchLocal({ type: "erase", itemId, date });
  } else {
    if (item.cells[date] === currentTool.value) return;
    dispatchLocal({ type: "paint", itemId, date, color: currentTool.value });
  }
}

function bindGanttPainting() {
  const scroll = $("#gantt-scroll");
  scroll.addEventListener("mousedown", (e) => {
    const td = e.target.closest(".gantt-cell");
    if (!td) return;
    e.preventDefault();
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
  dispatchLocal({ type: "addItem", item: { id: uid(), name: "新規工種", bold: false, cells: {} } });
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

function selectColor(color, btnEl) {
  currentTool = { type: "color", value: color };
  $$(".swatch").forEach((s) => s.classList.remove("selected"));
  if (btnEl) btnEl.classList.add("selected");
  $("#tool-erase").classList.remove("selected");
}

function bindToolbar() {
  $("#btn-add-item").addEventListener("click", addItem);
  $("#btn-print").addEventListener("click", () => window.print());

  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "工事工程表.json";
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
    const encoded = await encodeStateForHash(state);
    history.replaceState(null, "", location.pathname + location.search + "#" + encoded);
    try {
      await navigator.clipboard.writeText(location.href);
      showShareStatus("共有URLをコピーしました");
    } catch (e) {
      showShareStatus("コピーに失敗しました。アドレスバーのURLを共有してください");
    }
  });

  $("#btn-reset").addEventListener("click", () => {
    if (!confirm("すべてのデータを初期状態に戻します。よろしいですか？（全員に反映されます）")) return;
    dispatchLocal({ type: "resetAll", state: defaultState() });
    history.replaceState(null, "", location.pathname + location.search);
  });

  $("#tool-erase").addEventListener("click", (e) => {
    currentTool = { type: "erase", value: null };
    $$(".swatch").forEach((s) => s.classList.remove("selected"));
    e.target.classList.add("selected");
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
      ? raw.items.map((it) => ({
          id: it.id || uid(),
          name: it.name || "",
          bold: !!it.bold,
          cells: it.cells && typeof it.cells === "object" ? it.cells : {}
        }))
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
async function init() {
  const hash = location.hash ? location.hash.slice(1) : "";
  let loaded = null;
  if (hash) loaded = await decodeStateFromHash(hash);
  if (!loaded) loaded = loadLocal();
  state = loaded ? normalizeState(loaded) : defaultState();

  renderPalette();
  bindHeaderEvents();
  bindGanttPainting();
  bindToolbar();
  renderAll();
  saveLocal();

  startSync();
}

init();
})();
