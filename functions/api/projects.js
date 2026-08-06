function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

function uid() {
  return "it" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULT_ITEM_NAMES = ["準備工", "仮設工", "土工", "構造物工", "付帯工", "後片付け工"];

function initialState(meta) {
  return {
    meta,
    items: DEFAULT_ITEM_NAMES.map((name) => ({
      id: uid(), name, bold: true, level: 0, cells: {}, labels: {}
    })),
    progress: { plan: {}, actual: {} }
  };
}

function cleanMeta(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const str = (v) => (typeof v === "string" ? v.slice(0, 300) : "");
  return {
    projectName: str(r.projectName),
    orderer: str(r.orderer),
    location: str(r.location),
    supervisor: str(r.supervisor),
    contractor: str(r.contractor),
    contractDate: str(r.contractDate),
    createdDate: str(r.createdDate),
    startDate: str(r.startDate),
    endDate: str(r.endDate)
  };
}

// GET /api/projects -> { projects: [{ id, name, meta, createdAt, updatedAt }] }
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    "SELECT id, name, meta, created_at, updated_at FROM projects ORDER BY updated_at DESC LIMIT 500"
  ).all();

  const projects = results.map((r) => {
    let meta = {};
    try { meta = JSON.parse(r.meta); } catch (e) { /* 壊れていても一覧は返す */ }
    return { id: r.id, name: r.name, meta, createdAt: r.created_at, updatedAt: r.updated_at };
  });
  return json({ projects });
}

// POST /api/projects  body: { meta } -> { id }
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "invalid json" }, { status: 400 }); }

  const meta = cleanMeta(body && body.meta);
  if (!meta.projectName.trim()) {
    return json({ error: "工事名は必須です" }, { status: 400 });
  }

  const id = (crypto.randomUUID && crypto.randomUUID()) || uid();
  const now = Date.now();

  // 案件レコードと、工程表の初期状態(resetAll op)を同時に作る。
  // これで工程表ページを開いた時点でフォームの入力内容が反映されている。
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, name, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, meta.projectName, JSON.stringify(meta), now, now),
    env.DB.prepare(
      "INSERT INTO ops (room, op, ts) VALUES (?, ?, ?)"
    ).bind(id, JSON.stringify({ type: "resetAll", state: initialState(meta) }), now)
  ]);

  return json({ id });
}

// DELETE /api/projects?id=xxx
export async function onRequestDelete(context) {
  const { request, env } = context;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "missing id" }, { status: 400 });

  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops WHERE room = ?").bind(id),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id)
  ]);

  return json({ ok: true });
}
