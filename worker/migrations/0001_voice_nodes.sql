-- 語音節點註冊表。一個節點一列，心跳就是 upsert（每次 1 列寫入）。
-- KV 的 TTL 300 秒改用 last_seen 過濾：查詢時只回最近 5 分鐘有心跳的。
CREATE TABLE IF NOT EXISTS voice_nodes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  engine        TEXT NOT NULL,
  character     TEXT NOT NULL,
  version       TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  requires_key  INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_nodes_last_seen ON voice_nodes(last_seen);
