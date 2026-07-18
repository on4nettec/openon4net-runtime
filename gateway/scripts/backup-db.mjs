#!/usr/bin/env node
// RT-071 — thin CLI wrapper around src/services/backup-service.ts (compiled
// to dist/), same pattern as migrate.mjs. Requires a build to exist first.
import { runBackup, uploadBackupToCloud } from '../dist/services/backup-service.js';
import { isObjectStorageConfigured } from '../dist/lib/object-storage.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const backupDir = process.env.BACKUP_DIR || './backups';

// Only the fields object-storage.js's uploadFile()/isObjectStorageConfigured()
// actually read — this script doesn't run the full env.ts Zod validation
// migrate.mjs also skips, so a minimal object of just these is enough.
const env = {
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
  MINIO_PORT: Number(process.env.MINIO_PORT || 9000),
  MINIO_USE_SSL: process.env.MINIO_USE_SSL === 'true',
  MINIO_ROOT_USER: process.env.MINIO_ROOT_USER,
  MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD,
  MINIO_BUCKET: process.env.MINIO_BUCKET || 'o2n-files',
  MINIO_PUBLIC_URL: process.env.MINIO_PUBLIC_URL,
};

try {
  const { file } = runBackup(databaseUrl, backupDir);
  console.log(`Backup written to ${file}`);
  if (isObjectStorageConfigured(env)) {
    const uploadedKey = await uploadBackupToCloud(env, file);
    if (uploadedKey) console.log(`Uploaded to object storage: ${uploadedKey}`);
  }
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
