function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
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

const result = await env.DB.prepare(
  "INSERT INTO ops (room, op, ts) VALUES (?, ?, ?)"
  ).bind(room, JSON.stringify(body.op), Date.now()).run();

return jsonResponse({ seq: result.meta.last_row_id });
}
