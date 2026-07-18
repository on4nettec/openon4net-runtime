import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, getTestDatabaseUrl } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { getPresignedDownloadUrl } from '../lib/object-storage.js';
import {
  checkPgDumpAvailable,
  checkPgRestoreAvailable,
  pruneOldBackups,
  runBackup,
  runRestore,
  uploadBackupToCloud,
} from './backup-service.js';

const pgToolsAvailable = checkPgDumpAvailable() && checkPgRestoreAvailable();
const minioAvailable = Boolean(process.env.MINIO_ENDPOINT);
const describeIfMinio = minioAvailable ? describe : describe.skip;

/**
 * Real round trip against the actual test DB when pg_dump/pg_restore are on
 * PATH; skipped with a clear reason otherwise (this environment doesn't have
 * them — same honesty convention as migrator.ts's extension-availability
 * skip). Not a mock either way: when it runs, it shells out to the real
 * binaries against a real Postgres instance.
 */
describe.skipIf(!pgToolsAvailable)('backup-service (real pg_dump/pg_restore)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'o2n-backup-test-'));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runBackup() writes a real .dump file', () => {
    const { file } = runBackup(getTestDatabaseUrl(), tmpDir);
    expect(existsSync(file)).toBe(true);
    expect(file.endsWith('.dump')).toBe(true);
  });

  it('runBackup() then runRestore() round-trips into a scratch table without error', async () => {
    const db = createTestDb();
    const marker = `backup-test-${Date.now()}`;
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS backup_test_marker (label TEXT)`);
      await db.query(`INSERT INTO backup_test_marker (label) VALUES ($1)`, [marker]);

      const { file } = runBackup(getTestDatabaseUrl(), tmpDir);
      // Restoring into the SAME database it was dumped from — --clean --if-exists
      // drops+recreates objects, so this exercises a real restore without
      // needing a second live Postgres instance just for this test.
      runRestore(getTestDatabaseUrl(), file);

      const { rows } = await db.query<{ label: string }>(`SELECT label FROM backup_test_marker WHERE label = $1`, [marker]);
      expect(rows).toHaveLength(1);
    } finally {
      await db.query(`DROP TABLE IF EXISTS backup_test_marker`);
      await db.end();
    }
  });

  it('pruneOldBackups() deletes only files past the retention window', () => {
    const oldFile = join(tmpDir, 'o2n-backup-old.dump');
    const newFile = join(tmpDir, 'o2n-backup-new.dump');
    writeFileSync(oldFile, 'x');
    writeFileSync(newFile, 'x');

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(oldFile, oldTime, oldTime);

    const pruned = pruneOldBackups(tmpDir, 30);
    expect(pruned).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });
});

describe('backup-service without pg tools (always runs)', () => {
  it('runBackup() throws a clear error when pg_dump is unavailable', () => {
    if (pgToolsAvailable) return; // this environment has them — the graceful-failure path isn't reachable to test here
    expect(() => runBackup('postgres://fake', './backups')).toThrow('pg_dump is not on PATH');
  });
});

describe('uploadBackupToCloud (RT-071)', () => {
  it('returns null (not a throw) when object storage is not configured', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'o2n-backup-upload-test-'));
    const file = join(tmpDir, 'o2n-backup-fake.dump');
    writeFileSync(file, 'not a real dump, just bytes for the upload test');
    try {
      const result = await uploadBackupToCloud(createTestEnv(), file);
      expect(result).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describeIfMinio('uploadBackupToCloud (real MinIO)', () => {
  it('uploads the dump file privately under backups/ and it is fetchable via a presigned URL', async () => {
    const env = createTestEnv({
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
      MINIO_PORT: Number(process.env.MINIO_PORT ?? 9000),
      MINIO_ROOT_USER: process.env.MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD,
      MINIO_BUCKET: 'o2n-files-test-backups',
    });
    const tmpDir = mkdtempSync(join(tmpdir(), 'o2n-backup-upload-test-'));
    const content = `fake dump content ${Date.now()}`;
    const file = join(tmpDir, `o2n-backup-${Date.now()}.dump`);
    writeFileSync(file, content);

    try {
      const key = await uploadBackupToCloud(env, file);
      expect(key).toBe(`backups/${file.split(/[\\/]/).pop()}`);

      const url = await getPresignedDownloadUrl(env, key!);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);

      // Private by default — a naive unsigned request to the same key must not succeed.
      const base = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? 9000}`;
      const unsigned = await fetch(`${base}/o2n-files-test-backups/${key}`);
      expect(unsigned.status).not.toBe(200);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
