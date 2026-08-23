(() => {
"use strict";

const $ = (s) => document.querySelector(s);

function pad2(n) { return String(n).padStart(2, "0"); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  if (!y || !m || !d) return iso;
  return `${y}/${m}/${d}`;
}

function formatTimestamp(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function setStatus(msg, kind) {
  const el = $("#list-status");
  el.textContent = msg || "";
  el.className = "list-status" + (kind ? " status-" + kind : "");
  el.hidden = !msg;
}

/* ---------------- 一覧の読み込み ---------------- */
async function loadProjects() {
  setStatus("読み込み中…", "info");
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    renderProjects(data.projects || []);
    setStatus("", null);
  } catch (e) {
    renderProjects([]);
    setStatus(
      "工事一覧を読み込めませんでした。サーバー（Cloudflare Pages Functions と D1）の設定が未完了の可能性があります。",
      "error"
    );
  }
}

function renderProjects(projects) {
  const list = $("#project-list");
  list.innerHTML = "";
  $("#empty-state").hidden = projects.length > 0;

  projects.forEach((p) => {
    const meta = p.meta || {};
    const card = document.createElement("div");
    card.className = "project-card";

    const main = document.createElement("a");
    main.className = "project-main";
    main.href = `schedule.html?project=${encodeURIComponent(p.id)}`;

    const name = document.createElement("div");
    name.className = "project-name";
    name.textContent = p.name || "(名称未設定)";
    main.appendChild(name);

    const rows = [
      ["発注者", meta.orderer],
      ["工事場所", meta.location],
      ["施工者", meta.contractor]
    ].filter(([, v]) => v);

    if (rows.length) {
      const info = document.createElement("div");
      info.className = "project-info";
      rows.forEach(([label, value]) => {
        const span = document.createElement("span");
        span.className = "project-info-item";
        span.textContent = `${label}：${value}`;
        info.appendChild(span);
      });
      main.appendChild(info);
    }

    const period = document.createElement("div");
    period.className = "project-period";
    period.textContent = `工期：${formatDate(meta.startDate)} ～ ${formatDate(meta.endDate)}`;
    main.appendChild(period);

    const updated = document.createElement("div");
    updated.className = "project-updated";
    updated.textContent = `最終更新：${formatTimestamp(p.updatedAt)}`;
    main.appendChild(updated);

    card.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "project-actions";

    const openBtn = document.createElement("a");
    openBtn.className = "btn btn-accent";
    openBtn.href = main.href;
    openBtn.textContent = "工程表を開く";
    actions.appendChild(openBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => deleteProject(p));
    actions.appendChild(delBtn);

    card.appendChild(actions);
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
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = false;
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
$("#btn-new-project").addEventListener("click", openModal);
$("#btn-modal-close").addEventListener("click", closeModal);
$("#btn-modal-cancel").addEventListener("click", closeModal);
$("#new-project-form").addEventListener("submit", submitForm);
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target === $("#modal-backdrop")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-backdrop").hidden) closeModal();
});

loadProjects();
})();
