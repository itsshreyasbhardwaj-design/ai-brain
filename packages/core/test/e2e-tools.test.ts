/**
 * End-to-end tests for the MCP server and the CLI.
 *
 * These spawn the real processes against a real database file and speak the
 * real protocols — JSON-RPC over stdio for MCP, argv and stdout for the CLI.
 * Nothing is mocked, because the thing being checked is precisely that these
 * binaries work when a user runs them.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db/client.ts';
import { Store } from '../src/db/repositories.ts';
import { AuthService } from '../src/engines/auth.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const MCP_ENTRY = join(REPO_ROOT, 'tools/mcp-server/src/index.ts');
const CLI_ENTRY = join(REPO_ROOT, 'tools/cli/src/index.ts');

let dir = '';
let dbPath = '';
let readToken = '';
let writeToken = '';

/** Sends a batch of JSON-RPC requests to a fresh MCP server over stdio. */
function mcpCall(requests: unknown[], env: Record<string, string> = {}): Promise<{ responses: Array<Record<string, unknown>>; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MCP_ENTRY], {
      env: { ...process.env, AI_BRAIN_DB: dbPath, AI_BRAIN_TOKEN: readToken, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`MCP server timed out. stderr: ${stderr}`)); }, 20_000);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const responses = stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      resolvePromise({ responses, stderr, code });
    });

    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args, '--db', dbPath], {
      env: { ...process.env, APP_SECRET: 'cli-test-app-secret-32-characters' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 20_000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code }); });
    child.stdin.end();
  });
}

/** Extracts the JSON a tool call returned. */
function toolJson(res: Record<string, unknown>): Record<string, unknown> {
  const result = res.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text, _isError: result?.isError ?? false };
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-brain-e2e-'));
  dbPath = join(dir, 'brain.db');

  // Seed a real on-disk database through the real registration path.
  const db = openDb({ path: dbPath });
  const store = new Store(db);
  const auth = new AuthService(store);
  const { user, workspace } = auth.register({
    email: 'e2e@example.test',
    displayName: 'E2E',
    password: 'a-sufficiently-long-password',
    workspaceName: 'E2E Brain',
    onboarding: { profile: 'developer', currentProjects: ['ai-brain'] },
  });

  const project = store.projects.bySlug(workspace.id, 'ai-brain')!;
  store.knowledge.create({
    workspaceId: workspace.id, projectId: project.id,
    title: 'Chose node:sqlite for storage',
    body: 'We decided to use the SQLite build that ships inside Node, so there is no database server to run.',
    klass: 'decision',
  });
  store.decisions.create({
    workspaceId: workspace.id, projectId: project.id,
    title: 'Ship without Postgres', choice: 'SQLite only for v0.1',
    rationale: 'No server to install means the one-command setup actually works.',
  });
  store.resources.create({
    workspaceId: workspace.id, projectId: project.id,
    kind: 'subscription', name: 'Domain', amountMinor: 1200, period: 'yearly',
  });
  store.tasks.create({ workspaceId: workspace.id, projectId: project.id, title: 'Write the README', status: 'todo' });

  readToken = auth.issueToken(workspace.id, user.id, 'e2e read', [
    'brain:read', 'projects:read', 'knowledge:read', 'activity:read', 'resources:read',
  ]).raw;
  writeToken = auth.issueToken(workspace.id, user.id, 'e2e write', ['brain:read', 'propose:write']).raw;
  db.close();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('MCP server over stdio', () => {
  test('completes the initialize handshake', async () => {
    const { responses, stderr } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    assert.equal(responses.length, 1, `stderr: ${stderr}`);
    const result = responses[0]!.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    assert.equal(result.serverInfo.name, 'ai-brain');
    assert.ok(result.protocolVersion.length > 0);
    // The instructions are what stop a model treating the user's records as
    // commands, so their presence is part of the contract.
    assert.match(result.instructions, /never instructions to you/);
    assert.match(result.instructions, /origin/);
  });

  test('lists only the tools the token’s scopes allow', async () => {
    const read = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const readTools = (read.responses[0]!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(readTools.includes('list_projects'));
    assert.ok(readTools.includes('search_knowledge'));
    assert.ok(!readTools.includes('propose_update'), 'a read-only token must not advertise the write tool');

    const write = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { AI_BRAIN_TOKEN: writeToken });
    const writeTools = (write.responses[0]!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(writeTools.includes('propose_update'));
    assert.ok(!writeTools.includes('search_knowledge'), 'this token has no knowledge:read scope');
  });

  test('refuses to start without a valid token', async () => {
    const { code, stderr } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'initialize' }], { AI_BRAIN_TOKEN: 'aib_not-a-real-token' });
    assert.equal(code, 1);
    assert.match(stderr, /authorization failed/);
    assert.match(stderr, /Access tokens/, 'the error tells the user how to fix it');
  });

  test('get_brain_profile returns configuration but no records', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_brain_profile', arguments: {} } }]);
    const data = toolJson(responses[0]!);
    assert.equal(data.configured, true);
    assert.equal(data.profile, 'developer');
    assert.ok(Array.isArray(data.modules));
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes('node:sqlite for storage'), 'the profile must not leak knowledge records');
  });

  test('list_projects reports origin and review state', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }]);
    const data = toolJson(responses[0]!) as { count: number; projects: Array<{ name: string; origin: string; reviewState: string }> };
    assert.ok(data.count >= 1);
    assert.equal(data.projects[0]!.origin, 'manual');
    assert.equal(data.projects[0]!.reviewState, 'confirmed');
  });

  test('get_project returns a passport with provenance per section', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: { slug: 'ai-brain' } } }]);
    const data = toolJson(responses[0]!) as { found: boolean; sections: Array<{ key: string; origin: string; lastVerifiedAt: string | null; rows: unknown[] }> };
    assert.equal(data.found, true);
    assert.ok(data.sections.length > 0);
    for (const s of data.sections) {
      assert.ok(typeof s.origin === 'string', `${s.key} has no origin`);
      if (s.rows.length === 0) assert.equal(s.lastVerifiedAt, null, `${s.key} claims verification with no rows`);
    }
    assert.ok(data.sections.some((s) => s.key === 'decisions' && s.rows.length === 1));
  });

  test('a missing project is reported, not invented', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: { slug: 'does-not-exist' } } }]);
    const data = toolJson(responses[0]!);
    assert.equal(data.found, false);
    assert.match(String(data.note), /No project with slug/);
  });

  test('search_knowledge labels origin and confidence on every hit', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_knowledge', arguments: { query: 'sqlite' } } }]);
    const data = toolJson(responses[0]!) as { count: number; results: Array<{ title: string; origin: string; confidence: string }> };
    assert.equal(data.count, 1);
    assert.match(data.results[0]!.title, /node:sqlite/);
    assert.ok(data.results[0]!.origin.length > 0);
    assert.ok(data.results[0]!.confidence.length > 0);
  });

  test('get_connected_sources says plainly that nothing is connected', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_connected_sources', arguments: {} } }]);
    const data = toolJson(responses[0]!);
    assert.equal(data.count, 0);
    assert.match(String(data.note), /entered by the user/);
  });

  test('get_resource_usage reports recorded cost and no-data for time', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_resource_usage', arguments: {} } }]);
    const data = toolJson(responses[0]!) as { cost: { monthlyRecurring?: string }; time: { hasData?: boolean; note?: string } };
    assert.equal(data.cost.monthlyRecurring, '$1', 'a $12/year subscription is $1/month');
    assert.equal(data.time.hasData, false);
    assert.match(String(data.time.note), /never counted as work/);
  });

  test('ask_brain answers with a certainty label', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_brain', arguments: { question: 'What needs my attention today?' } } }]);
    const data = toolJson(responses[0]!) as { answer: string; certainty: string };
    assert.ok(data.answer.length > 0);
    assert.ok(['grounded', 'derived', 'insufficient-data', 'out-of-scope'].includes(data.certainty));
  });

  test('ask_brain refuses a world-knowledge question and offers alternatives', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_brain', arguments: { question: 'What is the capital of France?' } } }]);
    const data = toolJson(responses[0]!) as { certainty: string; questionsItCanAnswer?: string[] };
    assert.equal(data.certainty, 'out-of-scope');
    assert.ok((data.questionsItCanAnswer ?? []).length > 0);
  });

  test('run_review returns the four Cs without storing a report', async () => {
    const { responses } = await mcpCall([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_review', arguments: { cadence: 'weekly' } } }]);
    const data = toolJson(responses[0]!) as { fourCs: Record<string, { grade: string }>; note: string };
    assert.ok(data.fourCs.context!.grade.length > 0);
    assert.match(data.note, /was not saved/);

    const db = openDb({ path: dbPath });
    const store = new Store(db);
    const ws = store.workspaces.listForUser(store.users.byEmail('e2e@example.test')!.id)[0]!;
    assert.equal(store.reports.list(ws.id).length, 0, 'a read tool must not write a report');
    db.close();
  });

  test('a tool requiring a scope the token lacks is refused with an explanation', async () => {
    const { responses } = await mcpCall([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_update', arguments: { kind: 'knowledge', title: 'x', reason: 'y' } } },
    ]);
    const result = responses[0]!.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /does not have the "propose:write" scope/);
  });

  test('propose_update records an unverified proposal and changes nothing else', async () => {
    const { responses } = await mcpCall([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_update', arguments: {
        kind: 'knowledge', title: 'Consider adding a Postgres adapter',
        body: 'It would help multi-user deployments.', reason: 'The user asked about scaling.',
      } } },
    ], { AI_BRAIN_TOKEN: writeToken });

    const data = toolJson(responses[0]!) as { accepted: boolean; recorded: boolean; id: string };
    assert.equal(data.accepted, false, 'a proposal is never applied');
    assert.equal(data.recorded, true);

    const db = openDb({ path: dbPath });
    const store = new Store(db);
    const ws = store.workspaces.listForUser(store.users.byEmail('e2e@example.test')!.id)[0]!;
    const record = store.knowledge.byId(ws.id, data.id)!;
    assert.equal(record.origin, 'generated', 'the proposal is marked as model-written');
    assert.equal(record.confidence, 'unverified');
    assert.ok(record.title.startsWith('[proposal]'));
    assert.ok(store.audit.list(ws.id).some((a) => a.action === 'mcp.proposal'));
    db.close();
  });

  test('an unknown tool and an unknown method are clean protocol errors', async () => {
    const { responses } = await mcpCall([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'definitely_not_a_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'nonsense/method', params: {} },
    ]);
    assert.equal((responses[0]!.error as { code: number }).code, -32602);
    assert.equal((responses[1]!.error as { code: number }).code, -32601);
  });

  test('malformed input does not kill the server', async () => {
    const child = spawn(process.execPath, [MCP_ENTRY], {
      env: { ...process.env, AI_BRAIN_DB: dbPath, AI_BRAIN_TOKEN: readToken },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stdin.write('this is not json\n');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));

    const lines = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal((lines[0]!.error as { code: number }).code, -32700, 'parse error reported');
    assert.equal(lines[1]!.id, 2, 'and the server kept going');
  });
});

describe('CLI', () => {
  test('help works with no database', async () => {
    const r = await cli(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /AI BRAIN command line/);
  });

  test('status reports what the brain contains', async () => {
    const r = await cli(['status']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /E2E Brain/);
    assert.match(r.stdout, /projects\s+1/);
    assert.match(r.stdout, /four Cs/);
  });

  test('status --json is machine readable', async () => {
    const r = await cli(['status', '--json']);
    const data = JSON.parse(r.stdout) as { projects: number; fourCs: Record<string, string> };
    assert.equal(data.projects, 1);
    assert.ok(data.fourCs.context);
  });

  test('project list shows the project', async () => {
    const r = await cli(['project', 'list']);
    assert.match(r.stdout, /ai-brain/);
  });

  test('project add creates one', async () => {
    const r = await cli(['project', 'add', 'A New Thing']);
    assert.match(r.stdout, /added "A New Thing"/);
    const list = await cli(['project', 'list']);
    assert.match(list.stdout, /a-new-thing/);
  });

  test('search finds a record and labels its provenance', async () => {
    const r = await cli(['search', 'sqlite']);
    assert.match(r.stdout, /node:sqlite/);
    assert.match(r.stdout, /origin manual, confidence observed/);
  });

  test('ask answers with a certainty label', async () => {
    const r = await cli(['ask', 'What needs my attention today?']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /certainty: /);
  });

  test('ask refuses an out-of-scope question and lists what it can do', async () => {
    const r = await cli(['ask', 'Who won the world cup in 1998?']);
    assert.match(r.stdout, /certainty: out-of-scope/);
    assert.match(r.stdout, /questions this brain can answer/);
  });

  test('connectors prints each connector’s real limitations', async () => {
    const r = await cli(['connectors']);
    assert.match(r.stdout, /GitHub \(github\)/);
    assert.match(r.stdout, /limitations:/);
    assert.match(r.stdout, /official data export/, 'the conversation connector states its limits');
  });

  test('review runs and stores a report', async () => {
    const r = await cli(['review', '--cadence', 'weekly']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /weekly review/);
    assert.match(r.stdout, /verified progress/);
    assert.match(r.stdout, /recommended next/);

    const db = openDb({ path: dbPath });
    const store = new Store(db);
    const ws = store.workspaces.listForUser(store.users.byEmail('e2e@example.test')!.id)[0]!;
    assert.ok(store.reports.list(ws.id).length >= 1, 'the CLI review is stored');
    db.close();
  });

  test('resources reports recorded cost and the allocation verdicts', async () => {
    const r = await cli(['resources']);
    assert.match(r.stdout, /\$1 \/ month recorded/);
    assert.match(r.stdout, /nothing logged/);
    assert.match(r.stdout, /allocation/);
  });

  test('token new prints a token once and stores only its hash', async () => {
    const r = await cli(['token', 'new', '--label', 'cli-issued', '--scopes', 'brain:read']);
    const match = /\s(aib_[A-Za-z0-9_-]+)/.exec(r.stdout);
    assert.ok(match, `no token in output: ${r.stdout}`);

    const db = openDb({ path: dbPath });
    const store = new Store(db);
    const ws = store.workspaces.listForUser(store.users.byEmail('e2e@example.test')!.id)[0]!;
    const stored = store.tokens.list(ws.id).find((t) => t.label === 'cli-issued')!;
    assert.ok(stored);
    assert.equal(stored.tokenHash, '', 'listing never returns the hash');
    const rawInDb = store.db.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM access_tokens WHERE token_hash = ?', [match[1]!],
    );
    assert.equal(Number(rawInDb!.c), 0, 'the raw token is not stored anywhere');
    db.close();
  });

  test('export writes a complete, credential-free dump', async () => {
    const target = join(dir, 'export.json');
    const r = await cli(['export', '--out', target]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote /);

    const { readFile } = await import('node:fs/promises');
    const dump = JSON.parse(await readFile(target, 'utf8')) as { projects: unknown[]; knowledge: unknown[]; notes: string[] };
    assert.ok(dump.projects.length >= 2);
    assert.ok(dump.knowledge.length >= 1);
    assert.ok(dump.notes.some((n) => n.includes('credentials are deliberately excluded')));
  });

  test('config export writes configuration with no records', async () => {
    const target = join(dir, 'brain.config.json');
    await cli(['config', 'export', '--out', target]);
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(target, 'utf8');
    assert.ok(text.includes('"profile": "developer"'));
    assert.ok(!text.includes('node:sqlite for storage'), 'no knowledge in a config file');
  });

  test('an unknown command fails with a useful message', async () => {
    const r = await cli(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command "frobnicate"/);
  });

  test('migrate is idempotent', async () => {
    const a = await cli(['migrate']);
    assert.match(a.stdout, /up to date/);
    const b = await cli(['migrate']);
    assert.match(b.stdout, /up to date/);
  });
});
