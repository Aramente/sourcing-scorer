-- Migration 003: add user_id to preferred_companies for multi-tenant isolation
-- Existing rows get user_id='' (shared/default), visible to all users
-- New user additions get user_id=uid (private, deletable only by that user)

CREATE TABLE IF NOT EXISTS preferred_companies_new (
  user_id  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL,
  tier     INTEGER NOT NULL DEFAULT 2,
  category TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (user_id, name)
);

INSERT INTO preferred_companies_new (user_id, name, tier, category)
SELECT '', name, tier, category FROM preferred_companies;

DROP TABLE preferred_companies;

ALTER TABLE preferred_companies_new RENAME TO preferred_companies;
