/*
 * 工事工程表 → Excel(.xlsx) 出力
 * 外部ライブラリを使わず、OOXML(SpreadsheetML)を組み立ててZIP(無圧縮)にまとめる。
 */
(() => {
"use strict";

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------------- ZIP (store / 無圧縮) ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    dv.setUint16(8, 0, true);      // method: store
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Excelが受け付けない制御文字を除去
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function colName(n) { // 1 -> A
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISO(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0); }

function dayRange(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  const cur = parseISO(startISO), end = parseISO(endISO);
  if (isNaN(cur) || isNaN(end) || cur > end) return out;
  while (cur <= end) { out.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}

// "#4f8ef7" -> "FF4F8EF7"
function toARGB(color) {
  let c = String(color || "").trim();
  if (c.startsWith("#")) c = c.slice(1);
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(c)) c = "CCCCCC";
  return "FF" + c.toUpperCase();
}

/* ---------------- styles.xml ---------------- */
// 固定スタイル番号
const S_DEFAULT = 0;
const S_TITLE = 1;
const S_FIELD_LABEL = 2;  // ヘッダー項目名（太字・枠線・薄グレー）
const S_FIELD_VALUE = 3;  // ヘッダー値（枠線・左寄せ）
const S_TH = 4;           // 表ヘッダー（太字・中央・枠線・グレー）
const S_TH_SAT = 5;
const S_TH_SUN = 6;
const S_ITEM = 7;         // 工種名（枠線・左寄せ）
const S_ITEM_BOLD = 8;
const S_CELL = 9;         // 平日の空セル
const S_CELL_SAT = 10;
const S_CELL_SUN = 11;
const S_LABEL = 12;       // 作業名テキスト（枠線・左寄せ・小さめ）
const S_PROGRESS = 13;    // 出来高率の数値
const FIXED_STYLE_COUNT = 14;

const SAT_ARGB = "FFCFE8FF";
const SUN_ARGB = "FFFFDCB0";
const HEAD_ARGB = "FFF0F1F3";

function buildStyles(barColors) {
  // fills: 0,1 は予約。2=土, 3=日, 4=ヘッダー, 5.. = 工程バー色
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    solidFill(SAT_ARGB),
    solidFill(SUN_ARGB),
    solidFill(HEAD_ARGB)
  ];
  barColors.forEach((argb) => fills.push(solidFill(argb)));

  const fonts = [
    '<font><sz val="10"/><color rgb="FF22242A"/><name val="Meiryo"/></font>',
    '<font><b/><sz val="10"/><color rgb="FF22242A"/><name val="Meiryo"/></font>',
    '<font><b/><sz val="16"/><color rgb="FF22242A"/><name val="Meiryo"/></font>',
    '<font><sz val="8"/><color rgb="FF22242A"/><name val="Meiryo"/></font>'
  ];

  const borders = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border>' +
      '<left style="thin"><color rgb="FFBFC3C9"/></left>' +
      '<right style="thin"><color rgb="FFBFC3C9"/></right>' +
      '<top style="thin"><color rgb="FFBFC3C9"/></top>' +
      '<bottom style="thin"><color rgb="FFBFC3C9"/></bottom>' +
      '<diagonal/></border>'
  ];

  const xf = [];
  xf[S_DEFAULT]     = x(0, 0, 0, null);
  xf[S_TITLE]       = x(2, 0, 0, 'center');
  xf[S_FIELD_LABEL] = x(1, 4, 1, 'center');
  xf[S_FIELD_VALUE] = x(0, 0, 1, 'left');
  xf[S_TH]          = x(1, 4, 1, 'center');
  xf[S_TH_SAT]      = x(1, 2, 1, 'center');
  xf[S_TH_SUN]      = x(1, 3, 1, 'center');
  xf[S_ITEM]        = x(0, 0, 1, 'left');
  xf[S_ITEM_BOLD]   = x(1, 0, 1, 'left');
  xf[S_CELL]        = x(0, 0, 1, 'center');
  xf[S_CELL_SAT]    = x(0, 2, 1, 'center');
  xf[S_CELL_SUN]    = x(0, 3, 1, 'center');
  xf[S_LABEL]       = x(3, 0, 1, 'left');
  xf[S_PROGRESS]    = x(0, 0, 1, 'center');
  barColors.forEach((_, i) => { xf[FIXED_STYLE_COUNT + i] = x(0, 5 + i, 1, 'center'); });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join("")}</fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="${borders.length}">${borders.join("")}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xf.length}">${xf.join("")}</cellXfs>
</styleSheet>`;

  function solidFill(argb) {
    return `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`;
  }
  function x(fontId, fillId, borderId, align) {
    const alignment = align
      ? `<alignment horizontal="${align}" vertical="center"/>`
      : "";
    return `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
      ` applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1"' : ""}>` +
      alignment + "</xf>";
  }
}

/* ---------------- sheet1.xml ---------------- */
function buildSheet(state, barStyleOf, days) {
  const meta = state.meta || {};
  const totalCols = 1 + days.length;
  const lastCol = colName(Math.max(totalCols, 2));
  const valueEndCol = colName(Math.min(totalCols, 22)); // ヘッダー値の結合幅

  const rows = [];
  const merges = [];
  let r = 0;

  // --- タイトル ---
  r++;
  rows.push(row(r, [cell(1, r, "工 事 工 程 表", S_TITLE, "s")]));
  merges.push(`A${r}:${lastCol}${r}`);

  // --- 工事情報 ---
  const fields = [
    ["工　事　名", meta.projectName],
    ["発　注　者", meta.orderer],
    ["工 事 場 所", meta.location],
    ["設 計 ・ 監 理", meta.supervisor],
    ["施　工　者", meta.contractor],
    ["契 約 年 月 日", meta.contractDate],
    ["工　　　期", (meta.startDate || "") + (meta.endDate ? "　～　" + meta.endDate : "")],
    ["作　成　日", meta.createdDate]
  ];
  for (const [label, value] of fields) {
    r++;
    rows.push(row(r, [
      cell(1, r, label, S_FIELD_LABEL, "s"),
      cell(2, r, value || "", S_FIELD_VALUE, "s")
    ]));
    if (totalCols >= 3) merges.push(`B${r}:${valueEndCol}${r}`);
  }

  // --- 空行 ---
  r++;

  // --- 月ヘッダー ---
  const monthHeaderRow = ++r;
  const monthCells = [cell(1, monthHeaderRow, "項　　目", S_TH, "s")];
  let i = 0;
  while (i < days.length) {
    const d = days[i];
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    let span = 0;
    while (i + span < days.length) {
      const dd = days[i + span];
      if (`${dd.getFullYear()}-${dd.getMonth()}` !== key) break;
      span++;
    }
    const c0 = 2 + i;
    monthCells.push(cell(c0, monthHeaderRow, `${d.getFullYear()}年${d.getMonth() + 1}月`, S_TH, "s"));
    for (let k = 1; k < span; k++) monthCells.push(cell(c0 + k, monthHeaderRow, null, S_TH));
    if (span > 1) merges.push(`${colName(c0)}${monthHeaderRow}:${colName(c0 + span - 1)}${monthHeaderRow}`);
    i += span;
  }
  rows.push(row(monthHeaderRow, monthCells));

  // --- 日 / 曜日 ---
  const dayRowNum = ++r;
  rows.push(row(dayRowNum, [
    cell(1, dayRowNum, null, S_TH),
    ...days.map((d, idx) => cell(2 + idx, dayRowNum, d.getDate(), weekStyle(d, S_TH, S_TH_SAT, S_TH_SUN), "n"))
  ]));
  merges.push(`A${monthHeaderRow}:A${dayRowNum + 1}`);

  const wdRowNum = ++r;
  rows.push(row(wdRowNum, [
    cell(1, wdRowNum, null, S_TH),
    ...days.map((d, idx) => cell(2 + idx, wdRowNum, WEEKDAY_JP[d.getDay()], weekStyle(d, S_TH, S_TH_SAT, S_TH_SUN), "s"))
  ]));

  const freezeRow = wdRowNum + 1;

  // --- 工種行 ---
  for (const item of (state.items || [])) {
    const rn = ++r;
    const indent = "　".repeat(item.level || 0);
    const cells = [cell(1, rn, indent + (item.name || ""), item.bold ? S_ITEM_BOLD : S_ITEM, "s")];
    days.forEach((d, idx) => {
      const iso = isoDate(d);
      const color = item.cells ? item.cells[iso] : null;
      const label = item.labels ? item.labels[iso] : null;
      let style;
      if (color) style = barStyleOf(toARGB(color));
      else if (label) style = S_LABEL;
      else style = weekStyle(d, S_CELL, S_CELL_SAT, S_CELL_SUN);
      cells.push(cell(2 + idx, rn, label || null, style, label ? "s" : undefined));
    });
    rows.push(row(rn, cells));
  }

  // --- 空行 + 出来高率 ---
  r++;
  const progress = state.progress || { plan: {}, actual: {} };
  for (const [labelText, kind] of [["計 画 (%)", "plan"], ["実 績 (%)", "actual"]]) {
    const rn = ++r;
    const cells = [cell(1, rn, labelText, S_ITEM_BOLD, "s")];
    let j = 0;
    while (j < days.length) {
      const d = days[j];
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      let span = 0;
      while (j + span < days.length) {
        const dd = days[j + span];
        if (`${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}` !== key) break;
        span++;
      }
      const c0 = 2 + j;
      const v = progress[kind] ? progress[kind][key] : null;
      const hasVal = v !== undefined && v !== null && v !== "";
      cells.push(cell(c0, rn, hasVal ? v : null, S_PROGRESS, hasVal ? "n" : undefined));
      for (let k = 1; k < span; k++) cells.push(cell(c0 + k, rn, null, S_PROGRESS));
      if (span > 1) merges.push(`${colName(c0)}${rn}:${colName(c0 + span - 1)}${rn}`);
      j += span;
    }
    rows.push(row(rn, cells));
  }

  const cols =
    '<cols>' +
    '<col min="1" max="1" width="26" customWidth="1"/>' +
    (days.length ? `<col min="2" max="${totalCols}" width="2.9" customWidth="1"/>` : "") +
    '</cols>';

  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${Math.max(r, 1)}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0">
<pane xSplit="1" ySplit="${wdRowNum}" topLeftCell="B${freezeRow}" activePane="bottomRight" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${rows.join("")}</sheetData>
${mergeXml}
<pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.3" footer="0.3"/>
<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;

  function weekStyle(d, normal, sat, sun) {
    if (d.getDay() === 6) return sat;
    if (d.getDay() === 0) return sun;
    return normal;
  }
  function row(n, cs) { return `<row r="${n}">${cs.join("")}</row>`; }
  function cell(c, rn, value, style, type) {
    const ref = `${colName(c)}${rn}`;
    if (value === null || value === undefined || value === "") {
      return `<c r="${ref}" s="${style}"/>`;
    }
    if (type === "n") return `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }
}

/* ---------------- workbook ---------------- */
function buildWorkbook(state) {
  const meta = state.meta || {};
  const days = dayRange(meta.startDate, meta.endDate);

  // 使われている工程バーの色を集めてスタイル番号に割り当てる
  const colorIndex = new Map();
  for (const item of (state.items || [])) {
    for (const iso in (item.cells || {})) {
      const argb = toARGB(item.cells[iso]);
      if (!colorIndex.has(argb)) colorIndex.set(argb, colorIndex.size);
    }
  }
  const barColors = [...colorIndex.keys()];
  const barStyleOf = (argb) => FIXED_STYLE_COUNT + colorIndex.get(argb);

  const enc = new TextEncoder();
  const file = (name, text) => ({ name, data: enc.encode(text) });

  return zipStore([
    file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="工事工程表" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    file("xl/styles.xml", buildStyles(barColors)),
    file("xl/worksheets/sheet1.xml", buildSheet(state, barStyleOf, days))
  ]);
}

function safeFileName(s) {
  return String(s || "工事工程表").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "工事工程表";
}

function exportSchedule(state) {
  const bytes = buildWorkbook(state);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = safeFileName((state.meta && state.meta.projectName) || "工事工程表") + ".xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.KouteiXlsx = { exportSchedule, buildWorkbook };
})();
