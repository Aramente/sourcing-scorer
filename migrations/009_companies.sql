-- Company DB reframe (docs/specs/2026-07-02-company-db-reframe.md):
-- 10-20K enriched companies + per-job saved filter sets. Tiers
-- (preferred_companies / us_lookalike_companies) stay until cutover.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,            -- kbNormCompany output
  domain TEXT,
  linkedin_url TEXT UNIQUE,           -- export key; NULL until gap-filled
  hq_country TEXT, hq_city TEXT,
  region TEXT CHECK(region IN ('fr','eu','us')),
  industry TEXT,
  tech_stack TEXT NOT NULL DEFAULT '[]',
  business_model TEXT,
  employees_min INTEGER, employees_max INTEGER,
  revenue_bucket TEXT,
  revenue_source TEXT,                -- 'filed' | 'estimated'
  founded_year INTEGER,
  total_raised_usd INTEGER, last_round TEXT, last_round_date TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companies_region ON companies(region);
CREATE INDEX IF NOT EXISTS idx_companies_name_norm ON companies(name_norm);

CREATE TABLE IF NOT EXISTS job_company_filters (
  job_id TEXT NOT NULL, user_id TEXT NOT NULL,
  filters TEXT NOT NULL,              -- JSON: [{field, op, value, mode:'must'|'ranked', rank}]
  company_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER,
  PRIMARY KEY (job_id, user_id)
);
