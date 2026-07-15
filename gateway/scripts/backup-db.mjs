#!/usr/bin/env node
// RT-071 — thin CLI wrapper around src/services/backup-service.ts (compiled
// to dist/), same pattern as migrate.mjs. Requires a build to exist first.
import { runBackup } from '../dist/services/backup-service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const backupDir = process.env.BACKUP_DIR || './backups';

try {
  const { file } = runBackup(databaseUrl, backupDir);
  console.log(`Backup written to ${file}`);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
