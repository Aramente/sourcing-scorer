CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  kdf_iters INTEGER NOT NULL DEFAULT 10000,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS candidates (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  linkedin_url TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  import_name TEXT NOT NULL DEFAULT '',
  import_date INTEGER NOT NULL DEFAULT 0,
  facets TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, job_id, dedup_key)
);

-- Knowledge base (post-migration-006 shape): see migrations/006_knowledge_base.sql
CREATE TABLE IF NOT EXISTS title_facets (
  title_norm TEXT PRIMARY KEY,
  fam        TEXT NOT NULL DEFAULT 'other',
  seniority  TEXT NOT NULL DEFAULT 'mid',
  setting    TEXT NOT NULL DEFAULT 'unknown',
  flags      TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'llm',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS company_facts (
  company_norm TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'unknown',
  source       TEXT NOT NULL DEFAULT 'llm',
  updated_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS facet_weights (
  family_id TEXT NOT NULL,
  facet_key TEXT NOT NULL,
  keeps     INTEGER NOT NULL DEFAULT 0,
  excludes  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, facet_key)
);

-- Post-migration-003 shape: user_id='' rows are shared defaults, user_id=<uid> rows are personal
CREATE TABLE IF NOT EXISTS preferred_companies (
  user_id  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL,
  tier     INTEGER NOT NULL DEFAULT 2,
  category TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (user_id, name)
);
