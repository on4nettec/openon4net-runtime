-- RT-088: richer Agent Schedule needs a timezone to evaluate cron-style
-- patterns (hour/day-of-week/day-of-month) against — mirrors RT-083's
-- organizations.language column exactly (org-level default, IANA name).
-- No per-user override here (unlike language) since scheduling is agent-
-- level, not user-level, and there's no "acting user" for a scheduled run.

ALTER TABLE organizations ADD COLUMN timezone VARCHAR(50) NOT NULL DEFAULT 'UTC';
