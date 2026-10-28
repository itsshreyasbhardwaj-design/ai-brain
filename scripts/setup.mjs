#!/usr/bin/env node
/**
 * First-run setup.
 *
 * Creates .env with a generated APP_SECRET, makes the data directory, and
 * applies migrations — the three things that otherwise fail confusingly later.
 * Safe to run repeatedly: it never overwrites an existing .env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const examplePath = resolve(root, '.env.example');

if (existsSync(envPath)) {
  console.log('.env already exists — leaving it alone.');
} else {
  if (!existsSync(examplePath)) {
    console.error('.env.example is missing; cannot generate .env.');
    process.exit(1);
  }
  const secret = randomBytes(32).toString('base64url');
  const contents = readFileSync(examplePath, 'utf8').replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`);
  writeFileSync(envPath, contents, { mode: 0o600 });
  console.log('Created .env with a freshly generated APP_SECRET (mode 600).');
}

const dbPath = /^AI_BRAIN_DB=(.*)$/m.exec(readFileSync(envPath, 'utf8'))?.[1]?.trim() || './data/brain.db';
const absolute = resolve(root, dbPath);
mkdirSync(dirname(absolute), { recursive: true });

const { openDb } = await import(resolve(root, 'packages/core/src/db/client.ts'));
const db = openDb({ path: absolute });
console.log(`Database ready at ${absolute} (schema v${db.schemaVersion}).`);
db.close();

console.log('');
console.log('Next:  pnpm dev     then open http://localhost:3000');
