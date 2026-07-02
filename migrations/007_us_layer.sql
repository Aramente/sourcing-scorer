-- US sourcing layer: lookalike companies per US hiring city.
-- Unlike preferred_companies, a company can appear in several cities,
-- so the key is (city, name). Rows are shared (no user scoping);
-- the per-user state is which cities are enabled (user_settings.us_cities).
CREATE TABLE IF NOT EXISTS us_lookalike_companies (
  city     TEXT NOT NULL,
  name     TEXT NOT NULL,
  tier     INTEGER NOT NULL DEFAULT 2,  -- 1 = +15 pts, 2 = +10 pts (same scale as preferred_companies)
  category TEXT NOT NULL DEFAULT 'us_tech',
  PRIMARY KEY (city, name)
);

ALTER TABLE user_settings ADD COLUMN us_cities TEXT NOT NULL DEFAULT '[]';
