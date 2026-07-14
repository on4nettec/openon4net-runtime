-- Tamper-evidence for audit_logs (roadmap Phase 3 Governance, "Audit Log
-- کامل"). Nullable on purpose: existing rows (inserted before this shipped)
-- have no hash and are skipped by AuditService.verifyChain() rather than
-- treated as a break — the chain only covers rows from this point forward,
-- a documented limitation, not silently glossed over.
ALTER TABLE audit_logs
  ADD COLUMN prev_hash VARCHAR(64),
  ADD COLUMN row_hash VARCHAR(64);
