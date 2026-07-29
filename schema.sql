-- 工事工程表アプリ D1スキーマ
-- 何度実行しても安全です（既存テーブルはそのまま）。

-- 工程表の編集操作ログ。room = 工事案件ID。
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  op TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_room_id ON ops (room, id);

-- 工事案件（工程表1件＝1レコード）
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at DESC);
