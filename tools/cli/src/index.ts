#!/usr/bin/env node
/**
 * The `brain` CLI.
 *
 * Covers the operations a self-hoster needs without opening the web app:
 * migrations, account setup, adding projects, importing notes, syncing,
 * running reviews, issuing tokens, and exporting everything. Zero
 * dependencies — argument parsing is about forty lines below.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDb, pendingMigrations } from '../../../packages/core/src/db/client.ts';
import { Store } from '../../../packages/core/src/db/repositories.ts';
import { AuthService } from '../../../packages/core/src/engines/auth.ts';
import { KnowledgeEngine, parseMarkdown, parseConversationExport, type IngestDocument } from '../../../packages/core/src/engines/knowledge.ts';
import { ReviewEngine } from '../../../packages/core/src/engines/review.ts';
import { ResourceEngine, VERDICT_LABELS } from '../../../packages/core/src/engines/resources.ts';
import { AssistantEngine } from '../../../packages/core/src/engines/assistant.ts';
import { PortabilityEngine } from '../../../packages/core/src/engines/portability.ts';
import { DiscoveryEngine } from '../../../packages/core/src/engines/discovery.ts';
import { SyncRunner, adapterFor } from '../../../packages/core/src/connectors/sync.ts';
import { CONNECTORS, ROADMAP_CONNECTORS } from '../../../packages/core/src/connectors/registry.ts';
import { buildContextPackage, renderContextPackageMarkdown } from '../../../packages/core/src/ai/context-package.ts';
import { encryptSecret } from '../../../packages/core/src/security/secrets.ts';
import { isExcludedPath } from '../../../packages/core/src/security/redact.ts';
import { toConfigFile, fromConfigFile } from '../../../packages/core/src/engines/brain-config.ts';
import { relativeLabel } from '../../../packages/core/src/util/time.ts';
import { formatMoney } from '../../../packages/core/src/engines/passport.ts';
import type { ConnectorKey, TokenScope } from '../../../packages/core/src/domain/types.ts';

const DEFAULT_DB = `${process.env.HOME ?? '.'}/.ai-brain/brain.db`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key!] = inline;
      else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) flags[key!] = rest[++i]!;
      else flags[key!] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

function fail(s: string): never {
  process.stderr.write(`error: ${s}\n`);
  process.exit(1);
}

function flagStr(args: Args, name: string, fallback?: string): string {
  const v = args.flags[name];
  if (typeof v === 'string' && v !== '') return v;
  if (fallback !== undefined) return fallback;
  fail(`--${name} is required`);
}

async function prompt(question: string, silent = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!silent) return (await rl.question(question)).trim();
    // Node's readline has no built-in masking; the prompt says so rather than
    // pretending the input is hidden.
    return (await rl.question(`${question}(typed visibly) `)).trim();
  } finally {
    rl.close();
  }
}

const HELP = `
AI BRAIN command line

  brain migrate                        apply pending database migrations
  brain status                         show what this brain contains
  brain setup                          create the first account interactively
  brain whoami                         show the current workspace

  brain project add <name>             add a project
  brain project list                   list projects
  brain review-queue                   list discovered projects awaiting review
  brain confirm <slug>                 confirm a discovered project
  brain reject <slug>                  reject a discovered project

  brain import <path>                  import .md/.txt files, or a conversation export .json
  brain search <query>                 search the knowledge base
  brain ask "<question>"               ask the brain a question

  brain connect github --token <pat> [--allow owner/repo,...]
  brain connect local --dir <path> [--dir <path>]
  brain connections                    list connections and their freshness
  brain sync [--connector github]      run a sync
  brain forget <connector>             delete everything from one connector

  brain review [--cadence weekly]      run and store a review
  brain resources                      show recorded time, cost and allocation

  brain token new --label <name> [--scopes brain:read,projects:read] [--days 90]
  brain token list
  brain token revoke <id>

  brain export [--out file.json]       export everything
  brain import-export <file.json>      import an export into this workspace
  brain config export [--out brain.config.json]
  brain config import <file>
  brain connectors                     what each connector can and cannot do

Options
  --db <path>        database file (default ${DEFAULT_DB}, or $AI_BRAIN_DB)
  --json             machine-readable output where supported
`.trim();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags.help) {
    out(HELP);
    return;
  }

  const dbPath = flagStr(args, 'db', process.env.AI_BRAIN_DB ?? DEFAULT_DB);
  const asJson = args.flags.json === true;

  // Informational commands that describe the software rather than a brain.
  // These must work before there is an account: someone evaluating AI BRAIN
  // should be able to see what the connectors actually do first.
  if (args.command === 'connectors') {
    for (const c of Object.values(CONNECTORS)) {
      out(`${c.label} (${c.key})`);
      out(`  status:      ${c.status}`);
      out(`  mode:        ${c.mode}`);
      out(`  can:         ${c.capabilities.join(', ')}`);
      out(`  limitations: ${c.limitations}`);
      out('');
    }
    out('Not available in this release:');
    for (const r of ROADMAP_CONNECTORS) out(`  ${r.label} — ${r.why}`);
    return;
  }

  if (args.command === 'migrate') {
    const db = openDb({ path: dbPath });
    out(`database: ${dbPath}`);
    out(`schema version: ${db.schemaVersion}`);
    out(pendingMigrations(db).length === 0 ? 'up to date.' : `applied migrations, now at ${db.schemaVersion}.`);
    db.close();
    return;
  }

  const db = openDb({ path: dbPath });
  const store = new Store(db);
  const auth = new AuthService(store);

  try {
    if (args.command === 'setup') {
      if (!auth.needsSetup()) fail('this installation already has an account. Use the web app to sign in.');
      const email = await prompt('email: ');
      const displayName = (await prompt('your name: ')) || 'Me';
      const password = await prompt('password (min 10 chars): ', true);
      const profile = (await prompt('profile [developer/founder/creator/freelancer/research/personal/student/custom] (personal): ')) || 'personal';
      const { user, workspace } = auth.register({
        email, displayName, password,
        onboarding: { profile: profile as 'personal' },
      });
      out(`created account ${user.email} and workspace "${workspace.name}".`);
      out(`run \`pnpm dev\` and sign in, or keep using this CLI.`);
      return;
    }

    if (auth.needsSetup()) fail(`no account yet. Run \`brain setup\`, or start the app and open the first-run page.`);

    // Every command below operates on the first account's first workspace,
    // which is the single-user self-hosted case this CLI is built for.
    const user = store.users.byId(store.db.one<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')!.id)!;
    const { workspace } = auth.requireWorkspace(user, (args.flags.workspace as string) ?? null);
    const workspaceId = workspace.id;
    const config = store.brainConfig.current(workspaceId);

    switch (args.command) {
      case 'whoami': {
        out(`account:   ${user.email}`);
        out(`workspace: ${workspace.name} (${workspaceId})`);
        out(`profile:   ${config?.profile ?? 'none'} · modules: ${config?.modules.join(', ') ?? 'none'}`);
        out(`database:  ${dbPath}`);
        break;
      }

      case 'status': {
        const projects = store.projects.list(workspaceId, { limit: 10_000 });
        const pending = store.projects.list(workspaceId, { reviewState: ['pending-review'], limit: 1000 });
        const four = new ReviewEngine(store).fourCs(workspaceId, config);
        if (asJson) {
          out(JSON.stringify({
            projects: projects.length, pendingReview: pending.length,
            knowledge: store.knowledge.total(workspaceId),
            openTasks: store.tasks.list(workspaceId, { status: ['todo', 'doing', 'blocked'] }).length,
            connections: store.accounts.list(workspaceId).length,
            fourCs: { context: four.context.grade, connections: four.connections.grade, capabilities: four.capabilities.grade, cadence: four.cadence.grade },
          }, null, 2));
          break;
        }
        out(`${workspace.name} — ${config?.profile ?? 'unconfigured'} brain`);
        out('');
        out(`projects        ${projects.length}${pending.length ? ` (${pending.length} awaiting review)` : ''}`);
        out(`knowledge       ${store.knowledge.total(workspaceId)}`);
        out(`open tasks      ${store.tasks.list(workspaceId, { status: ['todo', 'doing', 'blocked'] }).length}`);
        out(`goals           ${store.goals.list(workspaceId).length}`);
        out(`decisions       ${store.decisions.list(workspaceId, { limit: 10_000 }).length}`);
        out(`connections     ${store.accounts.list(workspaceId).length}`);
        out('');
        out('four Cs');
        for (const a of [four.context, four.connections, four.capabilities, four.cadence]) {
          out(`  ${a.label.padEnd(13)} ${a.grade}`);
          for (const g of a.gaps.slice(0, 2)) out(`      gap: ${g}`);
        }
        break;
      }

      case 'project': {
        const sub = args.positional[0] ?? 'list';
        if (sub === 'add') {
          const name = args.positional.slice(1).join(' ') || flagStr(args, 'name');
          const p = store.projects.create({
            workspaceId, name,
            description: (args.flags.description as string) ?? '',
            category: ((args.flags.category as string) ?? 'other') as 'other',
            origin: 'manual',
          });
          out(`added "${p.name}" (${p.slug}).`);
        } else {
          const projects = store.projects.list(workspaceId, { limit: 500, reviewState: ['confirmed', 'pending-review'] });
          if (projects.length === 0) { out('no projects yet. `brain project add <name>` or connect a source.'); break; }
          if (asJson) { out(JSON.stringify(projects, null, 2)); break; }
          for (const p of projects) {
            const flag = p.reviewState === 'pending-review' ? ' [awaiting review]' : '';
            out(`${p.slug.padEnd(32)} ${p.lifecycle.padEnd(9)} ${relativeLabel(p.lastActivityAt).padEnd(10)} ${p.name}${flag}`);
          }
        }
        break;
      }

      case 'review-queue': {
        const queue = new DiscoveryEngine(store).reviewQueue(workspaceId);
        if (queue.length === 0) { out('nothing awaiting review.'); break; }
        for (const p of queue) {
          out(`${p.slug.padEnd(32)} confidence ${p.matchScore.toFixed(2)}  from ${p.sourceKey ?? 'unknown'}  ${p.name}`);
        }
        out('');
        out('`brain confirm <slug>` or `brain reject <slug>`');
        break;
      }

      case 'confirm':
      case 'reject': {
        const slug = args.positional[0] ?? fail('usage: brain confirm <slug>');
        const project = store.projects.bySlug(workspaceId, slug) ?? fail(`no project with slug "${slug}"`);
        const d = new DiscoveryEngine(store);
        if (args.command === 'confirm') { d.confirm(workspaceId, project.id); out(`confirmed "${project.name}".`); }
        else { d.reject(workspaceId, project.id); out(`rejected "${project.name}". Later syncs will not resurrect it.`); }
        break;
      }

      case 'import': {
        const target = resolve(args.positional[0] ?? fail('usage: brain import <path>'));
        const engine = new KnowledgeEngine(store);
        const opts = {
          allowFileContentImport: config?.privacy.allowFileContentImport ?? true,
          excludedCategories: config?.privacy.excludedCategories ?? [],
        };
        const st = await stat(target).catch(() => fail(`cannot read ${target}`));
        const docs: IngestDocument[] = [];

        if (st.isFile() && target.endsWith('.json')) {
          const parsed = parseConversationExport(await readFile(target, 'utf8'));
          if (parsed.length === 0) fail('that JSON file is not a recognised conversation export.');
          docs.push(...parsed);
        } else if (st.isFile()) {
          const p = parseMarkdown(basename(target), await readFile(target, 'utf8'));
          docs.push({ title: p.title, body: p.body, locator: target, tags: p.tags, origin: 'import' });
        } else {
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > 4) return;
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (isExcludedPath(full, config?.privacy.excludedPaths ?? [])) continue;
              if (entry.isDirectory()) await walk(full, depth + 1);
              else if (/\.(md|markdown|txt)$/i.test(entry.name)) {
                const p = parseMarkdown(entry.name, await readFile(full, 'utf8'));
                docs.push({ title: p.title, body: p.body, locator: full, tags: p.tags, origin: 'import' });
              }
            }
          };
          await walk(target, 0);
        }

        if (docs.length === 0) { out('no importable files found.'); break; }
        const r = engine.ingestBatch(workspaceId, target.endsWith('.json') ? 'conversation-export' : 'markdown', target, docs, opts);
        out(`imported ${r.created} record(s), skipped ${r.skipped} (duplicates or excluded).`);
        if (r.redactions > 0) out(`redacted ${r.redactions} secret-shaped value(s) before storing.`);
        if (r.contradictions > 0) out(`flagged ${r.contradictions} record(s) that contradict something already stored.`);
        break;
      }

      case 'search': {
        const query = args.positional.join(' ') || fail('usage: brain search <query>');
        const hits = store.knowledge.search(workspaceId, query, { limit: 20 });
        if (hits.length === 0) { out('no matches.'); break; }
        if (asJson) { out(JSON.stringify(hits, null, 2)); break; }
        for (const h of hits) {
          out(`${h.record.klass.padEnd(9)} ${h.record.title}`);
          out(`          ${h.snippet.slice(0, 140)}`);
          out(`          origin ${h.record.origin}, confidence ${h.record.confidence}${h.record.contradictsId ? ', CONFLICTS with another record' : ''}`);
        }
        break;
      }

      case 'ask': {
        const question = args.positional.join(' ') || fail('usage: brain ask "<question>"');
        const engine = new AssistantEngine(store);
        const answer = engine.ask(workspaceId, question, config);
        if (asJson) { out(JSON.stringify(answer, null, 2)); break; }
        out(answer.text);
        for (const b of answer.bullets) out(`  - ${b}`);
        out('');
        out(`certainty: ${answer.certainty}`);
        for (const c of answer.citations) out(`  source: ${c.label} — ${c.source}`);
        for (const c of answer.caveats) out(`  note: ${c}`);
        if (answer.certainty === 'out-of-scope') {
          out('');
          out('questions this brain can answer:');
          for (const q of engine.capabilities()) out(`  - ${q}`);
        }
        break;
      }

      case 'connect': {
        const which = (args.positional[0] ?? '') as ConnectorKey | 'local' | 'github';
        const appSecret = process.env.APP_SECRET ?? fail('APP_SECRET must be set to store a credential');

        if (which === 'github') {
          const token = flagStr(args, 'token');
          const allowlist = String(args.flags.allow ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const adapter = adapterFor('github')!;
          const verified = await adapter.verify({
            connector: 'github', accountLabel: '', credential: token, allowlist, cursor: null,
            privacy: { excludedPaths: [], excludedCategories: [], allowFileContentImport: true },
          });
          if (!verified.ok) fail(verified.error ?? 'GitHub rejected that token');
          const account = store.accounts.create({
            workspaceId, connector: 'github', accountLabel: verified.accountLabel,
            credentialCipher: encryptSecret(token, appSecret),
            scopes: verified.scopes, allowlist,
          });
          out(`connected GitHub as ${verified.accountLabel} (${account.id}).`);
          out(allowlist.length === 0
            ? 'no allowlist set, so every repository this token can see is in scope. Use --allow owner/repo to narrow it.'
            : `allowlisted: ${allowlist.join(', ')}`);
          out('run `brain sync` to discover projects.');
        } else if (which === 'local') {
          const dirs = (Array.isArray(args.flags.dir) ? args.flags.dir : [args.flags.dir])
            .filter((d): d is string => typeof d === 'string')
            .flatMap((d) => d.split(','))
            .map((d) => resolve(d.trim()))
            .filter(Boolean);
          if (dirs.length === 0) fail('usage: brain connect local --dir <path>');
          const adapter = adapterFor('local-directory')!;
          const verified = await adapter.verify({
            connector: 'local-directory', accountLabel: '', credential: null, allowlist: dirs, cursor: null,
            privacy: { excludedPaths: [], excludedCategories: [], allowFileContentImport: true },
          });
          if (!verified.ok) fail(verified.error ?? 'those directories cannot be read');
          store.accounts.create({
            workspaceId, connector: 'local-directory', accountLabel: verified.accountLabel,
            credentialCipher: null, scopes: ['read'], allowlist: dirs,
          });
          out(`authorized ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}:`);
          for (const d of dirs) out(`  ${d}`);
          out('run `brain sync` to discover projects.');
        } else {
          fail(`unknown connector "${which}". Supported here: github, local. See \`brain connectors\`.`);
        }
        break;
      }

      case 'connections': {
        const accounts = store.accounts.list(workspaceId);
        if (accounts.length === 0) { out('nothing connected. `brain connect github --token <pat>` or `brain connect local --dir <path>`'); break; }
        for (const a of accounts) {
          const def = CONNECTORS[a.connector];
          out(`${(def?.label ?? a.connector).padEnd(20)} ${a.accountLabel.padEnd(24)} ${a.status.padEnd(9)} last sync ${relativeLabel(a.lastSyncAt)}`);
          if (a.lastError) out(`  last error: ${a.lastError}`);
          if (def) out(`  ${def.limitations}`);
        }
        break;
      }

      case 'sync': {
        const appSecret = process.env.APP_SECRET;
        const only = args.flags.connector as string | undefined;
        const accounts = store.accounts.list(workspaceId).filter((a) => a.status !== 'revoked' && (!only || a.connector === only));
        if (accounts.length === 0) { out('nothing to sync.'); break; }
        const runner = new SyncRunner(store);
        for (const account of accounts) {
          out(`syncing ${account.connector} (${account.accountLabel})…`);
          try {
            const result = await runner.run(workspaceId, account.id, {
              trigger: 'manual',
              ...(appSecret ? { appSecret } : {}),
            });
            const s = result.stats;
            out(`  sources seen ${s.sourcesSeen}, written ${s.sourcesWritten}`);
            out(`  projects created ${s.projectsCreated}, updated ${s.projectsUpdated}, queued for review ${s.projectsQueuedForReview}`);
            out(`  activity ${s.activityWritten}, metrics ${s.metricsWritten}, skipped by privacy ${s.skippedByPrivacy}`);
            if (s.retries > 0 || s.rateLimitWaits > 0) out(`  retries ${s.retries}, rate-limit waits ${s.rateLimitWaits}`);
            for (const w of result.warnings) out(`  warning: ${w}`);
            for (const q of result.queuedForReview) out(`  review: ${q.name} (confidence ${q.score.toFixed(2)}) — ${q.reason}`);
          } catch (err) {
            out(`  failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        break;
      }

      case 'forget': {
        const connector = args.positional[0] ?? fail('usage: brain forget <connector>');
        if (args.flags.yes !== true) {
          const sure = await prompt(`delete every record imported from "${connector}"? type yes: `);
          if (sure !== 'yes') { out('cancelled.'); break; }
        }
        const { deleted } = new PortabilityEngine(store).deleteSourceData(workspaceId, connector);
        out(`deleted ${deleted.sources} source record(s), ${deleted.knowledge} knowledge record(s), ${deleted.activity} activity event(s).`);
        out(`archived ${deleted.projectsArchived} project(s) that came from it (your own notes on them are kept).`);
        break;
      }

      case 'review': {
        const cadence = ((args.flags.cadence as string) ?? config?.reportingCadence ?? 'weekly') as 'weekly';
        const { body } = new ReviewEngine(store).runReview(workspaceId, cadence, config);
        if (asJson) { out(JSON.stringify(body, null, 2)); break; }
        out(`${cadence} review · ${body.periodStart.slice(0, 10)} to ${body.periodEnd.slice(0, 10)}`);
        const section = (title: string, lines: string[]): void => {
          out('');
          out(title);
          if (lines.length === 0) out('  (nothing)');
          for (const l of lines) out(`  - ${l}`);
        };
        section('verified progress', body.verifiedProgress);
        section('bottlenecks', body.bottlenecks);
        section('resources', body.resourceUtilisation);
        section('data quality', body.dataQuality);
        section('recommended next', body.topActions);
        break;
      }

      case 'resources': {
        const engine = new ResourceEngine(store);
        const cost = engine.costReport(workspaceId);
        const time = engine.timeReport(workspaceId, 30);
        out('cost');
        out(cost.hasData
          ? `  ${formatMoney(cost.monthlyRecurringMinor, cost.currency)} / month recorded, ${formatMoney(cost.yearlyRecurringMinor, cost.currency)} / year`
          : '  nothing recorded.');
        for (const a of cost.anomalies) out(`  anomaly: ${a.resource.name} — ${a.reason}`);
        out('');
        out('time (30 days)');
        out(time.hasData ? `  ${(time.totalMinutes / 60).toFixed(1)} h logged across ${time.byProject.length} project(s)` : '  nothing logged.');
        out('');
        out('allocation');
        for (const row of engine.allocation(workspaceId).slice(0, 20)) {
          out(`  ${row.project.name.padEnd(30)} ${VERDICT_LABELS[row.verdict]}`);
          out(`      ${row.because.join('; ')}`);
        }
        break;
      }

      case 'token': {
        const sub = args.positional[0] ?? 'list';
        if (sub === 'new') {
          const label = flagStr(args, 'label');
          const scopes = String(args.flags.scopes ?? 'brain:read,projects:read,knowledge:read,activity:read,resources:read')
            .split(',').map((s) => s.trim()).filter(Boolean) as TokenScope[];
          const days = args.flags.days ? Number(args.flags.days) : undefined;
          const { raw } = auth.issueToken(workspaceId, user.id, label, scopes, days);
          out('token created. It is shown once and only its hash is stored:');
          out('');
          out(`  ${raw}`);
          out('');
          out(`scopes: ${scopes.join(', ')}`);
          out('to use it with an MCP client:');
          out(`  AI_BRAIN_DB=${dbPath} AI_BRAIN_TOKEN=${raw} node tools/mcp-server/src/index.ts`);
        } else if (sub === 'revoke') {
          const id = args.positional[1] ?? fail('usage: brain token revoke <id>');
          auth.revokeToken(workspaceId, id, user.id);
          out('revoked.');
        } else {
          const tokens = store.tokens.list(workspaceId);
          if (tokens.length === 0) { out('no tokens issued.'); break; }
          for (const t of tokens) {
            out(`${t.id.padEnd(30)} ${t.label.padEnd(24)} ${t.revokedAt ? 'revoked' : 'active '} last used ${relativeLabel(t.lastUsedAt)}`);
            out(`  scopes: ${t.scopes.join(', ')}`);
          }
        }
        break;
      }

      case 'export': {
        const data = new PortabilityEngine(store).export(workspaceId);
        const target = (args.flags.out as string) ?? `ai-brain-export-${new Date().toISOString().slice(0, 10)}.json`;
        await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
        out(`wrote ${target}`);
        out(`projects ${data.projects.length}, knowledge ${data.knowledge.length}, tasks ${data.tasks.length}, decisions ${data.decisions.length}`);
        for (const n of data.notes) out(`note: ${n}`);
        break;
      }

      case 'import-export': {
        const file = args.positional[0] ?? fail('usage: brain import-export <file.json>');
        const raw = JSON.parse(await readFile(file, 'utf8'));
        const { imported, warnings } = new PortabilityEngine(store).importWorkspace(workspaceId, raw);
        out('imported:');
        for (const [k, v] of Object.entries(imported)) out(`  ${k.padEnd(16)} ${v}`);
        for (const w of warnings) out(`warning: ${w}`);
        break;
      }

      case 'context': {
        const pkg = buildContextPackage(store, workspaceId, config, {
          ...(args.flags.maxProjects ? { maxProjects: Number(args.flags.maxProjects) } : {}),
        });
        const markdown = args.flags.markdown === true;
        const target = (args.flags.out as string) ?? (markdown ? 'ai-brain-context.md' : 'ai-brain-context.json');
        await writeFile(target, markdown ? renderContextPackageMarkdown(pkg) : JSON.stringify(pkg, null, 2), 'utf8');
        out(`wrote ${target}`);
        out('it contains no credentials and can be pasted into any assistant.');
        break;
      }

      case 'config': {
        const sub = args.positional[0] ?? 'export';
        if (sub === 'export') {
          if (!config) fail('this workspace has no configuration');
          const target = (args.flags.out as string) ?? 'brain.config.json';
          await writeFile(target, JSON.stringify(toConfigFile(config), null, 2), 'utf8');
          out(`wrote ${target} (configuration only, no records).`);
        } else if (sub === 'import') {
          const file = args.positional[1] ?? fail('usage: brain config import <file>');
          const raw = JSON.parse(await readFile(file, 'utf8'));
          const next = fromConfigFile(raw, workspaceId);
          const saved = store.brainConfig.save(next);
          for (const key of saved.modules) store.modules.setEnabled(workspaceId, key, true);
          out(`imported configuration as version ${saved.version}. Previous versions are kept.`);
        }
        break;
      }

      case 'reset': {
        if (args.flags.yes !== true) fail('this deletes everything. Re-run with --yes if you mean it.');
        new PortabilityEngine(store).deleteWorkspace(workspaceId, user.id);
        out('workspace deleted.');
        break;
      }

      default:
        fail(`unknown command "${args.command}". Run \`brain help\`.`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
