(() => {
"use strict";

const $ = (s) => document.querySelector(s);

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

function pad2(n) { return String(n).padStart(2, "0"); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseISO(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

function formatDate(iso) {
  const d = parseISO(iso);
  if (!d) return "—";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTimestamp(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

function setStatus(msg, kind) {
  const box = $("#list-status");
  box.textContent = msg || "";
  box.className = "list-status" + (kind ? " status-" + kind : "");
  box.hidden = !msg;
}

/* 工期のどのあたりにいるか（着工前／施工中／工期終了）。
   あくまで日付の経過であって、出来高ではない。 */
function periodStatus(meta) {
  const s = parseISO(meta.startDate);
  const e = parseISO(meta.endDate);
  const t = parseISO(todayISO());
  if (!s || !e || e < s) return null;
  const total = daysBetween(s, e) + 1;
  if (t < s) return { kind: "before", label: `着工前（あと${daysBetween(t, s)}日）`, pct: 0 };
  if (t > e) return { kind: "done", label: "工期終了", pct: 100 };
  const passed = daysBetween(s, t) + 1;
  return {
    kind: "running",
    label: `施工中（残り${daysBetween(t, e)}日）`,
    pct: Math.round((passed / total) * 100)
  };
}

/* ---------------- 一覧の読み込み ---------------- */
let allProjects = [];
let loadFailed = false;

async function loadProjects() {
  setStatus("読み込み中…", "info");
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    allProjects = data.projects || [];
    loadFailed = false;
    setStatus("", null);
  } catch (e) {
    allProjects = [];
    loadFailed = true;
    setStatus(
      "工事一覧を読み込めませんでした。通信状況を確認して、ページを開き直してください。",
      "error"
    );
  }
  renderProjects();
}

function renderProjects() {
  const list = $("#project-list");
  list.textContent = "";

  // 件数が増えてきたら絞り込み欄を出す
  $("#list-tools").hidden = allProjects.length < 6;
  const q = ($("#list-search").value || "").trim().toLowerCase();
  const projects = !q ? allProjects : allProjects.filter((p) => {
    const m = p.meta || {};
    return [p.name, m.orderer, m.location, m.contractor].some((v) => String(v || "").toLowerCase().includes(q));
  });

  const empty = $("#empty-state");
  empty.hidden = projects.length > 0 || loadFailed;
  if (!projects.length && allProjects.length) {
    $("#empty-title").textContent = "該当する工事がありません";
    $("#empty-desc").textContent = "絞り込みの文字を変えてみてください。";
    $("#btn-new-project-empty").hidden = true;
  } else {
    $("#empty-title").textContent = "まだ工事が登録されていません";
    $("#empty-desc").textContent = "最初の工事を登録すると、工程表を作れるようになります。";
    $("#btn-new-project-empty").hidden = false;
  }

  projects.forEach((p) => {
    const meta = p.meta || {};
    const href = `schedule.html?project=${encodeURIComponent(p.id)}`;
    const card = el("article", "project-card");

    const link = el("a", "project-link");
    link.href = href;
    link.setAttribute("aria-label", `${p.name || "(名称未設定)"} の工程表を開く`);
    card.appendChild(link);

    const top = el("div", "project-top");
    top.appendChild(el("div", "project-name", p.name || "(名称未設定)"));
    const del = el("button", "icon-btn project-del");
    del.type = "button";
    del.title = "この工事を削除";
    del.setAttribute("aria-label", "この工事を削除");
    del.appendChild(icon("trash", "icon-sm"));
    del.addEventListener("click", () => deleteProject(p));
    top.appendChild(del);
    card.appendChild(top);

    const info = el("div", "project-meta");
    [["発注者", meta.orderer], ["場所", meta.location], ["施工者", meta.contractor]]
      .filter(([, v]) => v)
      .forEach(([label, value]) => info.appendChild(el("span", "", `${label}：${value}`)));
    info.appendChild(el("span", "", `工期：${formatDate(meta.startDate)} 〜 ${formatDate(meta.endDate)}`));
    card.appendChild(info);

    const st = periodStatus(meta);
    if (st) {
      const bar = el("div", "project-bar");
      bar.title = `工期の経過 ${st.pct}%`;
      const fill = el("i");
      fill.style.width = st.pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    const foot = el("div", "project-foot");
    foot.appendChild(st ? el("span", "chip status-chip " + st.kind, st.label) : el("span"));
    foot.appendChild(el("span", "", p.updatedAt ? `更新 ${formatTimestamp(p.updatedAt)}` : ""));
    card.appendChild(foot);

    list.appendChild(card);
  });
}

async function deleteProject(p) {
  const label = p.name || "(名称未設定)";
  if (!confirm(`「${label}」を削除します。\n工程表のデータもすべて消え、元に戻せません。よろしいですか？`)) return;
  try {
    const res = await fetch(`/api/projects?id=${encodeURIComponent(p.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("status " + res.status);
    await loadProjects();
  } catch (e) {
    setStatus("削除に失敗しました。時間をおいて再度お試しください。", "error");
  }
}

/* ---------------- 新規作成フォーム ---------------- */
function openModal() {
  const form = $("#new-project-form");
  form.reset();
  form.elements.createdDate.value = todayISO();
  $("#form-error").hidden = true;
  $("#modal-backdrop").hidden = false;
  form.elements.projectName.focus();
}

function closeModal() {
  $("#modal-backdrop").hidden = true;
}

function showFormError(msg) {
  const box = $("#form-error");
  box.textContent = msg;
  box.hidden = false;
  if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
}

async function submitForm(e) {
  e.preventDefault();
  const form = e.target;
  const meta = {
    projectName: form.elements.projectName.value.trim(),
    orderer: form.elements.orderer.value.trim(),
    location: form.elements.location.value.trim(),
    supervisor: form.elements.supervisor.value.trim(),
    contractor: form.elements.contractor.value.trim(),
    contractDate: form.elements.contractDate.value,
    createdDate: form.elements.createdDate.value || todayISO(),
    startDate: form.elements.startDate.value,
    endDate: form.elements.endDate.value
  };

  if (!meta.projectName) return showFormError("工事名を入力してください。");
  if (!meta.startDate || !meta.endDate) return showFormError("工期の開始日と終了日を入力してください。");
  if (meta.startDate > meta.endDate) return showFormError("工期の終了日は、開始日より後の日付にしてください。");

  const submitBtn = $("#btn-modal-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "作成中…";

  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta })
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (err) { /* ignore */ }
      throw new Error(detail || "status " + res.status);
    }
    const data = await res.json();
    location.href = `schedule.html?project=${encodeURIComponent(data.id)}`;
  } catch (err) {
    showFormError("作成に失敗しました：" + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = "この内容で作成する";
  }
}

/* ---------------- init ---------------- */
["#btn-new-project", "#btn-new-project-fab", "#btn-new-project-empty"].forEach((sel) => {
  $(sel).addEventListener("click", openModal);
});
$("#btn-modal-close").addEventListener("click", closeModal);
$("#btn-modal-cancel").addEventListener("click", closeModal);
$("#new-project-form").addEventListener("submit", submitForm);
$("#list-search").addEventListener("input", renderProjects);
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target === $("#modal-backdrop")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-backdrop").hidden) closeModal();
});

loadProjects();
})();
