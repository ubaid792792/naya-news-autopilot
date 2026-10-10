CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  name TEXT,
  category TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT DEFAULT 'rss',
  interval_minutes INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 5,
  created_at TEXT,
  last_fetched_at TEXT,
  last_error TEXT,
  last_count INTEGER
);

CREATE TABLE IF NOT EXISTS seen (
  guid TEXT PRIMARY KEY,
  title_key TEXT,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS seen_at_idx ON seen (seen_at);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  status TEXT,
  source_url TEXT,
  source_name TEXT,
  source_title TEXT,
  headline TEXT,
  highlights TEXT,
  caption TEXT,
  hashtags TEXT,
  image_key TEXT,
  image_prompt TEXT,
  alt_text TEXT,
  category TEXT,
  image_model TEXT,
  text_model TEXT,
  run_id TEXT,
  caption_short TEXT,
  channel_results TEXT,
  error TEXT,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_at);
CREATE INDEX IF NOT EXISTS posts_published_idx ON posts (published_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  mode TEXT,
  trigger TEXT,
  status TEXT,
  summary TEXT,
  log TEXT,
  gh_run_url TEXT
);
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at);

-- Rendered news images live in D1 (instantly consistent) so Buffer can fetch them the moment
-- a post is sent; KV can lag up to a minute at other Cloudflare locations.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  created_at TEXT
);

-- Daily counters for free-tier limits (AI neurons, Buffer posts per channel, Buffer API calls, Instagram posts).
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
