/*
 * ローカル動作確認用の簡易サーバー
 *
 *   node dev-server.mjs        → http://localhost:5174
 *
 * public/ を配信しつつ、public/functions/api/*.js（本番と同じコード）を
 * Node上で実行します。D1 の代わりに Node 内蔵の SQLite をメモリ上に使うため、
 * サーバーを止めるとデータは消えます。
 *
 * ※ あくまで本番(Cloudflare Pages + D1)の近似です。最終確認は必ずデプロイ先で行ってください。
 * ※ Node 22.5 以降が必要です（node:sqlite を使用）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 5174);

const db = new DatabaseSync(":memory:");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--")) // コメント行を落としてから文で分割する
  .join("\n");
for (const stmt of schema.split(";")) {
  const s = stmt.trim();
  if (s) db.exec(s);
}

// public/functions/api/*.js は ESM だが拡張子が .js のため、
// data: URL 経由で読み込んでそのまま実行する。
async function loadFunction(name) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, "functions", "api", name), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

const routes = {
  "/api/ops": await loadFunction("ops.js"),
  "/api/op": await loadFunction("op.js"),
  "/api/projects": await loadFunction("projects.js")
};

/* ---- D1 互換の最小シム（D1 の実体は SQLite） ---- */
function statement(sql) {
  let args = [];
  const self = {
    bind(...a) { args = a; return self; },
    all() { return { results: db.prepare(sql).all(...args) }; },
    run() {
      const info = db.prepare(sql).run(...args);
      return { meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
    }
  };
  return self;
}
const env = {
  DB: { prepare: statement, batch: (stmts) => stmts.map((s) => s.run()) }
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const mod = routes[url.pathname];
  if (mod) {
    const handler =
      req.method === "GET" ? mod.onRequestGet :
      req.method === "POST" ? mod.onRequestPost :
      req.method === "DELETE" ? mod.onRequestDelete : null;
    if (!handler) { res.writeHead(405).end(); return; }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    });

    try {
      const out = await handler({ request, env });
      const text = await out.text();
      res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") || "application/json" });
      res.end(text);
    } catch (e) {
      console.error("FUNCTION ERROR", url.pathname, e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`工程表アプリ ローカルサーバー: http://localhost:${PORT}`));
