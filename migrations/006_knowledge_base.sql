-- Knowledge base: LLM-taught, permanently cached title/company classifications
-- plus per-job-family keep/exclude counters learned from triage decisions.

CREATE TABLE IF NOT EXISTS title_facets (
  title_norm TEXT PRIMARY KEY,
  fam        TEXT NOT NULL DEFAULT 'other',    -- role family, same keys as client ROLE_FAMILIES
  seniority  TEXT NOT NULL DEFAULT 'mid',      -- junior | mid | senior | lead | exec
  setting    TEXT NOT NULL DEFAULT 'unknown',  -- in_house | cabinet | freelance | interim | unknown
  flags      TEXT NOT NULL DEFAULT '[]',       -- JSON array: own_practice, student, seeking...
  source     TEXT NOT NULL DEFAULT 'llm',      -- llm | manual (manual is never overwritten)
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS company_facts (
  company_norm TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'unknown', -- company | accounting_firm | consulting_esn | agency | recruitment | freelance_self | education | public_sector | unknown
  source       TEXT NOT NULL DEFAULT 'llm',
  updated_at   INTEGER NOT NULL DEFAULT 0
);

-- Shared (team-wide) learning: every keep/exclude decision bumps the counters
-- for the candidate's facet keys within the job's family.
CREATE TABLE IF NOT EXISTS facet_weights (
  family_id TEXT NOT NULL,                     -- job family, e.g. 'accounting'
  facet_key TEXT NOT NULL,                     -- e.g. 'setting=cabinet', 'seniority=exec'
  keeps     INTEGER NOT NULL DEFAULT 0,
  excludes  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, facet_key)
);

ALTER TABLE candidates ADD COLUMN facets TEXT NOT NULL DEFAULT '';
