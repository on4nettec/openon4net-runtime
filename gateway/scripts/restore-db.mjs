#!/usr/bin/env node
// RT-071 — thin CLI wrapper around src/services/backup-service.ts. This
// environment can't answer an interactive y/N prompt, so --confirm is a
// required flag instead — the safety rail against accidental data loss is
// "you must type it out explicitly", not a prompt.
import { runRestore } from '../dist/services/backup-service.js';

const [, , backupFile, ...flags] = process.argv;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!backupFile) {
  console.error('Usage: restore-db.mjs <backup-file> --confirm');
  process.exit(1);
}
if (!flags.includes('--confirm')) {
  console.error('Refusing to restore without --confirm — this overwrites the target database.');
  process.exit(1);
}

try {
  runRestore(databaseUrl, backupFile);
  console.log('Restore complete');
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
