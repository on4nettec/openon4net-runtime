#!/usr/bin/env node
// RT-029 CLI entry point — for manual runs when DB_AUTO_MIGRATE=false (see
// src/index.ts). Thin wrapper: the actual logic lives in src/migrator.ts
// (compiled to dist/migrator.js) so it's shared with the startup path
// instead of duplicated — this script therefore requires a build to exist
// first (`pnpm run build`), same as the `start` script already does.
import { runMigrations } from '../dist/migrator.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

runMigrations(databaseUrl)
  .then(() => {
    console.log('done');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
