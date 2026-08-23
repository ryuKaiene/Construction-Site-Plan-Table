function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

// 一覧表示用に projects 側の名前・更新日時を追従させる。
// 工程表本体の状態はあくまで ops ログが正で、ここでは触らない。
function projectSyncStatement(env, room, op, now) {
  if (op.type === "setMeta" && op.key === "projectName") {
    return env.DB.prepare(
      "UPDATE projects SET name = ?, meta = json_set(meta, '$.projectName', ?), updated_at = ? WHERE id = ?"
    ).bind(String(op.value || ""), String(op.value || ""), now, room);
  }
  if (op.type === "setMeta") {
    return env.DB.prepare(
      "UPDATE projects SET meta = json_set(meta, '$.' || ?, ?), updated_at = ? WHERE id = ?"
    ).bind(String(op.key), String(op.value == null ? "" : op.value), now, room);
  }
  if (op.type === "resetAll" && op.state && op.state.meta) {
    const meta = op.state.meta;
    return env.DB.prepare(
      "UPDATE projects SET name = ?, meta = ?, updated_at = ? WHERE id = ?"
    ).bind(String(meta.projectName || ""), JSON.stringify(meta), now, room);
  }
  return env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, room);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const room = url.searchParams.get("room") || "default";

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, { status: 400 }); }
  if (!body || typeof body.op !== "object" || body.op === null) {
    return jsonResponse({ error: "missing op" }, { status: 400 });
  }

  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO ops (room, op, ts) VALUES (?, ?, ?)"
  ).bind(room, JSON.stringify(body.op), now).run();

  try {
    await projectSyncStatement(env, room, body.op, now).run();
  } catch (e) {
    // 案件レコードが無い（旧URLなど）場合でも編集自体は成立させる
  }

  return jsonResponse({ seq: result.meta.last_row_id });
}
