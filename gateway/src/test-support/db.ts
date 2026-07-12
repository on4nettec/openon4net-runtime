import { createDb, type Db } from '../db.js';

/**
 * Real Postgres, not mocked — same convention used in Memory/Marketplace/
 * Control-Plane's test-support/db.ts this session. Runtime itself had no
 * vitest test files before this batch (RT-001..029 were all verified via
 * curl/Playwright per docs/spect/DONE.md) — this is the first.
 */
export function getTestDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://on4netdbuser:Password_123@localhost:5432/o2n';
}

export function createTestDb(): Db {
  return createDb(getTestDatabaseUrl());
}

/** Collision-safe id per test run. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
