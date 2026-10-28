#!/usr/bin/env node
/**
 * Repository checks that are cheap enough to run on every commit.
 *
 * Deliberately not ESLint: the rules worth enforcing here are project-specific
 * invariants — no committed secrets, no stray debugging, no TypeScript syntax
 * that Node's type stripping cannot run — and each one is a few lines. Style is
 * left to the reader.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'data', 'coverage', '.pnpm-store']);
const CODE = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx']);

const problems = [];
let checked = 0;

const RULES = [
  {
    name: 'committed secret',
    // Shapes that are always a mistake in a repository.
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
    // Tests and the redactor itself legitimately contain credential-shaped
    // strings: that is what they are checking for. Everywhere else, a match is
    // either a real leak or something that looks enough like one to review.
    allow: (f) => f.includes('redact.ts') || f.endsWith('.test.ts'),
  },
  {
    name: 'leftover debugging',
    re: /^\s*(?:console\.log\(|debugger;)/m,
    // scripts, tools and examples are command line programs: printing is
    // their output, not leftover debugging.
    allow: (f) =>
      f.startsWith('scripts/') || f.startsWith('tools/') || f.startsWith('examples/') ||
      f.includes('.test.ts') || f.includes('layout.tsx'),
  },
  {
    name: 'focused test (it.only / describe.only)',
    re: /\b(?:it|test|describe)\.only\(/,
    allow: () => false,
  },
  {
    name: 'TypeScript syntax Node cannot strip (enum / namespace / parameter property)',
    // Node runs .ts by stripping types; these constructs emit code and fail.
    re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+\w|^\s*namespace\s+\w|constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w+\s*:/m,
    allow: (f) => f.startsWith('apps/web/'),
  },
];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!CODE.has(extname(entry.name))) continue;
    const rel = relative(root, full);
    const source = await readFile(full, 'utf8');
    checked++;
    for (const rule of RULES) {
      if (rule.allow(rel)) continue;
      const match = rule.re.exec(source);
      if (match) {
        const line = source.slice(0, match.index).split('\n').length;
        problems.push(`${rel}:${line}  ${rule.name}`);
      }
    }
  }
}

await walk(root);

if (problems.length > 0) {
  console.error(`lint: ${problems.length} problem(s) in ${checked} file(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`lint: ${checked} file(s) checked, no problems.`);
