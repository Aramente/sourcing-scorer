-- Migration 004: add import_name and import_date to candidates for sub-project support
-- Existing rows get import_name='' (shown as "Legacy import") and import_date=0
ALTER TABLE candidates ADD COLUMN import_name TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN import_date INTEGER NOT NULL DEFAULT 0;
