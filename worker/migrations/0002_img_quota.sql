-- 每日出圖額度。一個人（IP 的 SHA-256 前 16 位元組）一天一列，n 是已用張數。
-- 佔額度用 INSERT ... ON CONFLICT DO UPDATE ... WHERE n < 上限 RETURNING n，一句完成，不會兩個請求一起擠過最後一格。
CREATE TABLE IF NOT EXISTS img_quota (
  day  TEXT NOT NULL,              -- 台北日期 YYYY-MM-DD
  who  TEXT NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, who)
);

-- 記住哪個 job 是誰的哪一天，畫失敗時把那格還回去；refunded 防止同一個 job 還兩次。
CREATE TABLE IF NOT EXISTS img_jobs (
  job_id    TEXT PRIMARY KEY,
  day       TEXT NOT NULL,
  who       TEXT NOT NULL,
  refunded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_img_jobs_day ON img_jobs(day);
