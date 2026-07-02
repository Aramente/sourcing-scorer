# Company DB reframe — spec (approved 2026-07-02)

Kevin's decisions: broad tech universe (FR/EU/US); free sources + Clay credits,
cash budget ≤ $100 (Serper ~$15, Pappers ~$15, Growth List Starter ~$29–49;
NO TheirStack); must-have + drag-ranked filters; export = CSV of LinkedIn
company URLs (Sales Nav account-list format).

## What changes

Company tiers die. Instead, each job gets a skippable **Step 1: Companies**:
filter a 10–20K company DB, rank the filters that matter for this job, export
the resulting company list to Sales Nav, then continue the existing flow
(people search → CSV/scrape import → triage). Candidate scoring boost comes
from membership in the job's own filtered company list (strength from rank),
not global tiers.

## Data model (D1)

```sql
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,            -- kbNormCompany output
  domain TEXT,
  linkedin_url TEXT UNIQUE,           -- export key; nullable until gap-filled
  hq_country TEXT, hq_city TEXT,
  region TEXT CHECK(region IN ('fr','eu','us')),
  industry TEXT,
  tech_stack TEXT DEFAULT '[]',       -- JSON array, from job postings/GitHub
  business_model TEXT,                -- b2b_saas | b2c | marketplace | services | other (LLM/Clay)
  employees_min INTEGER, employees_max INTEGER,
  revenue_bucket TEXT,                -- e.g. '1-10M'
  revenue_source TEXT,                -- 'filed' (FR/Pappers) | 'estimated'
  founded_year INTEGER,
  total_raised_usd INTEGER, last_round TEXT, last_round_date TEXT,
  sources TEXT DEFAULT '[]',          -- JSON provenance
  updated_at INTEGER
);
CREATE INDEX idx_companies_region ON companies(region);
CREATE INDEX idx_companies_name_norm ON companies(name_norm);

CREATE TABLE job_company_filters (    -- saved filter set per job per user
  job_id TEXT NOT NULL, user_id TEXT NOT NULL,
  filters TEXT NOT NULL,              -- JSON: [{field, op, value, mode:'must'|'ranked', rank}]
  company_ids TEXT DEFAULT '[]',      -- JSON: resolved export snapshot
  updated_at INTEGER,
  PRIMARY KEY (job_id, user_id)
);
```

Migration also: drop the tier bonus from scoring once `companies` is populated;
`preferred_companies` + `us_lookalike_companies` names become seeds (tagged in
`sources`), tables kept until cutover is verified, then removed.

## Pipeline (`pipeline/`, local, monthly re-run)

1. `01_download_pdl` — PDL free company dataset (CC BY 4.0) backbone.
2. `02_filter_backbone` — FR/EU/US + tech industries + linkedin_url present,
   size 11–10K employees; quotas ≈ 5–7K FR / 4–6K EU / 5–7K US.
3. `03_merge_seeds` — USA Cybersec CSV (966), FR scale-ups (416), tier names
   (504), US lookalikes (5,941). Seeds always survive dedup (domain, then name).
4. `04_gapfill_linkedin` — website-footer scrape then Serper (~$15) for
   seed rows missing linkedin_url.
5. `05_funding` — Growth List month export join (~$29–49).
6. `06_revenue` — Pappers for FR (real filed CA, revenue_source='filed');
   estimates elsewhere flagged 'estimated'.
7. `07_tech_stack` — GitHub org languages + Greenhouse/Lever/Ashby public
   APIs + WTTJ for FR. Free only.
8. `08_business_model` — Clay subroutine or Workers AI batch classification.
9. `09_upsert_d1` — chunked INSERT OR REPLACE via wrangler; provenance merged.

Refresh: LaunchAgent monthly, or a "Refresh data" doc in pipeline/README.md.

## UI (public/index.html)

- Job open → Step 1 Companies panel (skippable, remembers last choice).
- Filters: region/country, industry, tech stack (any-of), business model,
  employees range, revenue bucket, founded after, raised range.
  Each filter chip toggles must-have (hard) or ranked (drag to reorder).
- Live count + preview list (name, city, employees, raised, stack chips).
- Export: CSV of linkedin_url (Sales Nav account list) + copy names button.
  Saved per job (job_company_filters), re-applied after monthly refresh.
- Scoring: candidate company ∈ job's exported list → boost scaled by the
  matched filter's rank; replaces prefMap tier bonus.

## Worker endpoints

- `GET /api/companies?filters=...` — paged filter query + count.
- `GET/POST /api/jobs/:id/company-filters` — saved sets.
- `GET /api/jobs/:id/company-export.csv` — the LinkedIn URL CSV.

## Out of scope (later)

- Direct "send to scraper" of company lists (localhost:3456).
- TheirStack ($300+) full job-posting tech stacks.
- Clay bulk enrichment of the whole DB.
