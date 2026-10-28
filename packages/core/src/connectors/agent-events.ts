/**
 * Push-based event ingest for coding agents (Claude Code, Codex).
 *
 * Neither of these is something AI BRAIN can poll: there is no documented
 * endpoint that hands a third-party application your agent activity. What they
 * do offer is a place for *you* to send events from — a hook you install in
 * Claude Code's own settings, or a thin wrapper around the Codex CLI.
 *
 * So these connectors are receivers. They validate a scoped token, accept a
 * small, well-defined event shape, and attach it to a project. `fetch()`
 * deliberately does nothing and says why, rather than pretending to sync.
 */

import type { ConnectorAdapter, ConnectorContext, FetchResult } from './types.ts';
import { emptyFetchResult } from './types.ts';
import type { ProjectCandidate } from '../engines/discovery.ts';
import type { ConnectorKey, Iso } from '../domain/types.ts';
import { basename, resolve } from 'node:path';
import { ValidationError } from '../util/validate.ts';

/** The event shape the ingest endpoint accepts. Intentionally small. */
export interface AgentEvent {
  /** Which agent produced it. */
  agent: 'claude-code' | 'codex';
  /** e.g. "session.start", "tool.use", "file.edit", "session.end". */
  kind: string;
  /** One line, already written by the sender. Never a transcript. */
  summary: string;
  /** Absolute path of the working directory, used to attach to a project. */
  cwd?: string;
  /** Explicit project name, when the sender knows it. */
  project?: string;
  occurredAt?: Iso;
  /** Small, non-sensitive extras. Capped and stringified on the way in. */
  detail?: Record<string, unknown>;
}

export interface InterpretedAgentEvent {
  connector: ConnectorKey;
  externalId: string;
  kind: string;
  summary: string;
  occurredAt: Iso;
  /** Set when the event names a directory we can treat as a project. */
  candidate: ProjectCandidate | null;
  payload: Record<string, unknown>;
  locator: string;
}

const MAX_SUMMARY = 500;
const ALLOWED_KINDS = /^[a-z][a-z0-9_.-]{1,48}$/;

/**
 * Validates and normalises one posted event.
 *
 * Rejects rather than coerces: a malformed event from a user's own hook should
 * be a visible 400, not a silently mangled row.
 */
export function interpretAgentEvent(raw: unknown): InterpretedAgentEvent {
  if (typeof raw !== 'object' || raw === null) throw new ValidationError('body', 'must be a JSON object');
  const e = raw as Record<string, unknown>;

  const agent = e.agent;
  if (agent !== 'claude-code' && agent !== 'codex') {
    throw new ValidationError('agent', 'must be "claude-code" or "codex"');
  }
  const kind = String(e.kind ?? '').trim();
  if (!ALLOWED_KINDS.test(kind)) {
    throw new ValidationError('kind', 'must be a short lowercase identifier such as "session.start"');
  }
  const summary = String(e.summary ?? '').trim().slice(0, MAX_SUMMARY);
  if (summary === '') throw new ValidationError('summary', 'is required');

  const occurredAt = e.occurredAt ? new Date(String(e.occurredAt)) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new ValidationError('occurredAt', 'must be a valid date');

  // Keep only scalar detail, capped, so a hook cannot post a whole transcript.
  const detail: Record<string, unknown> = {};
  if (typeof e.detail === 'object' && e.detail !== null && !Array.isArray(e.detail)) {
    let n = 0;
    for (const [k, v] of Object.entries(e.detail)) {
      if (n++ >= 20) break;
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        detail[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 300) : v;
      }
    }
  }

  const cwd = typeof e.cwd === 'string' && e.cwd.trim() !== '' ? resolve(e.cwd.trim()) : null;
  const projectName = typeof e.project === 'string' && e.project.trim() !== ''
    ? e.project.trim().slice(0, 200)
    : cwd
      ? basename(cwd)
      : null;

  // Events from the same working directory collapse onto the same project, so
  // a hundred tool-use events do not create a hundred projects.
  const externalId = cwd ? `cwd:${cwd}` : projectName ? `project:${projectName}` : 'unattached';
  const locator = cwd ?? projectName ?? `${agent}:unattached`;

  const candidate: ProjectCandidate | null = projectName
    ? {
        connector: agent,
        externalId,
        name: projectName,
        description: '',
        category: 'software',
        lifecycle: 'active',
        tags: [agent],
        locator,
        sourceId: null,
        lastActivityAt: occurredAt.toISOString(),
        // A directory an agent ran in is evidence of activity, but it could be
        // anyone's code — a dependency, a clone, a scratch dir. Kept far
        // enough below the auto-register threshold that even with the bonuses
        // discovery adds for recency it still lands in the review queue.
        connectorConfidence: 0.6,
      }
    : null;

  return {
    connector: agent,
    externalId,
    kind,
    summary,
    occurredAt: occurredAt.toISOString(),
    candidate,
    payload: { agent, kind, cwd, project: projectName, detail },
    locator,
  };
}

/** Shared adapter for both agents: receives, never polls. */
class AgentReceiverConnector implements ConnectorAdapter {
  readonly key: ConnectorKey;
  private readonly note: string;

  constructor(key: ConnectorKey, note: string) {
    this.key = key;
    this.note = note;
  }

  async verify(ctx: ConnectorContext): Promise<{ ok: boolean; accountLabel: string; scopes: string[]; error?: string }> {
    // Nothing to verify against: the trust boundary is the scoped access token
    // the sender presents on each request, checked by the ingest endpoint.
    return { ok: true, accountLabel: ctx.accountLabel || this.key, scopes: ['events:write'] };
  }

  async fetch(): Promise<FetchResult> {
    const out = emptyFetchResult();
    out.warnings.push(this.note);
    return out;
  }
}

export const claudeCodeConnector = new AgentReceiverConnector(
  'claude-code',
  'Claude Code is a receiver, not a poll source. Events arrive from the hook you install in your own Claude Code settings; running a sync does not fetch anything.',
);

export const codexConnector = new AgentReceiverConnector(
  'codex',
  'Codex is a receiver, not a poll source. There is no documented interface for reading Codex activity, so events must be posted by a wrapper you run yourself.',
);

/**
 * The hook snippet shown in the UI.
 *
 * Printed for the user to paste into their own settings. AI BRAIN never writes
 * to a global configuration file on the user's behalf.
 */
export function claudeCodeHookSnippet(baseUrl: string, token: string): string {
  const masked = token ? token : '<your-access-token>';
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  `jq -nc --arg cwd "$CLAUDE_PROJECT_DIR" '{agent:"claude-code",kind:"session.start",summary:"Claude Code session started",cwd:$cwd}' ` +
                  `| curl -sS -X POST ${baseUrl}/api/ingest/agent -H 'content-type: application/json' ` +
                  `-H 'authorization: Bearer ${masked}' --data-binary @-`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

export function codexWrapperSnippet(baseUrl: string, token: string): string {
  const masked = token ? token : '<your-access-token>';
  return [
    '#!/usr/bin/env bash',
    '# Save as ~/bin/codex-brain, make it executable, and use it instead of `codex`.',
    'set -euo pipefail',
    'post() {',
    `  curl -sS -X POST ${baseUrl}/api/ingest/agent \\`,
    "    -H 'content-type: application/json' \\",
    `    -H 'authorization: Bearer ${masked}' \\`,
    '    -d "{\\"agent\\":\\"codex\\",\\"kind\\":\\"$1\\",\\"summary\\":\\"$2\\",\\"cwd\\":\\"$PWD\\"}" >/dev/null || true',
    '}',
    'post session.start "Codex session started"',
    'trap \'post session.end "Codex session ended"\' EXIT',
    'codex "$@"',
  ].join('\n');
}
