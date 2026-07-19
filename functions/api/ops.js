const BATCH_LIMIT = 500;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const room = url.searchParams.get("room") || "default";
  const since = Number(url.searchParams.get("since") || "0") || 0;

const { results } = await env.DB.prepare(
  "SELECT id, op FROM ops WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?"
  ).bind(room, since, BATCH_LIMIT).all();

const ops = results.map((r) => ({ seq: r.id, op: JSON.parse(r.op) }));
  return new Response(JSON.stringify({ ops }), {
    headers: { "Content-Type": "application/json" }
  });
}
