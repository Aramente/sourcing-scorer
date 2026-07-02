-- Migration 005: auth hardening
-- kdf_iters: per-user PBKDF2 iteration count. Existing rows were hashed at 10k;
-- the Worker transparently rehashes to 600k on the next successful login.
-- failed_count / locked_until: login lockout (10 failures -> 15 min lock).

ALTER TABLE users ADD COLUMN kdf_iters INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE users ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
