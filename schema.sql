CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  user_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  action TEXT NOT NULL,
  PRIMARY KEY (user_id, candidate_key)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  hot_threshold INTEGER NOT NULL DEFAULT 65,
  filter_cfo INTEGER NOT NULL DEFAULT 1,
  filter_interim INTEGER NOT NULL DEFAULT 1,
  filter_expert_comptable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, user_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL,
  term TEXT NOT NULL,
  PRIMARY KEY (user_id, term)
);

CREATE TABLE IF NOT EXISTS hidden_patterns (
  user_id TEXT NOT NULL,
  pattern_label TEXT NOT NULL,
  pattern_regex TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern_label)
);

CREATE TABLE IF NOT EXISTS refine_state (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
