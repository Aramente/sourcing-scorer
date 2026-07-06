-- The existing PRIMARY KEY (user_id, job_id, dedup_key) uses dedup_key = name|company,
-- which lets the same LinkedIn profile get re-imported as a "new" candidate whenever the
-- scraper resolves a different company snapshot (job change, re-resolution) between imports.
-- linkedin_url is the stable identity; enforce uniqueness on it too, scoped per job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_user_job_url
  ON candidates(user_id, job_id, linkedin_url)
  WHERE linkedin_url != '';
