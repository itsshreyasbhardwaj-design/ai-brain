/**
 * Connector registry.
 *
 * `status` and `limitations` here are the single source of truth for what this
 * release can actually do, and the UI renders them verbatim. A connector that
 * needs a file the user exports by hand says so; it is never dressed up as a
 * live integration. Nothing in this file promises account-wide access to a
 * third-party product that does not offer it.
 */

import type { Connector, ConnectorKey } from '../domain/types.ts';

export const CONNECTORS: Record<ConnectorKey, Connector> = {
  github: {
    key: 'github',
    label: 'GitHub',
    capabilities: ['discover', 'activity', 'metrics', 'webhook'],
    mode: 'api-poll',
    limitations:
      'Reads only repositories you allowlist, using a personal access token with read scopes. ' +
      'Webhook delivery is supported but must be configured on the repository by you; ' +
      'without it, changes appear on the next sync rather than instantly.',
    status: 'supported',
  },
  'local-directory': {
    key: 'local-directory',
    label: 'Local directory',
    capabilities: ['discover', 'documents'],
    mode: 'local-filesystem',
    limitations:
      'Reads only directories you explicitly authorize, and never descends into node_modules, .git, ' +
      '.ssh or files matching the secret-file denylist. Runs on the machine hosting AI BRAIN, ' +
      'so in a remote deployment it sees the server’s filesystem, not your laptop.',
    status: 'supported',
  },
  'markdown-import': {
    key: 'markdown-import',
    label: 'Markdown and text import',
    capabilities: ['documents'],
    mode: 'manual-export',
    limitations:
      'You upload the files. There is no live connection to a notes app, so nothing updates ' +
      'until you import again.',
    status: 'supported',
  },
  'claude-code': {
    key: 'claude-code',
    label: 'Claude Code',
    capabilities: ['activity', 'documents'],
    mode: 'local-filesystem',
    limitations:
      'Receives events from a hook you install yourself in Claude Code settings, and can read ' +
      'session transcripts from a directory you authorize. AI BRAIN never installs a global hook ' +
      'for you and has no access to your Claude account.',
    status: 'experimental',
  },
  codex: {
    key: 'codex',
    label: 'OpenAI Codex',
    capabilities: ['activity'],
    mode: 'manual-export',
    limitations:
      'Accepts events posted to the ingest endpoint by a wrapper you run yourself. ' +
      'There is no documented interface for reading Codex activity directly, so this ' +
      'connector cannot poll anything on its own.',
    status: 'experimental',
  },
  'conversation-import': {
    key: 'conversation-import',
    label: 'AI conversation import',
    capabilities: ['documents'],
    mode: 'manual-export',
    limitations:
      'Works from the official data export that ChatGPT or Claude gives you. ' +
      'Neither product offers unrestricted account-wide chat history access to third-party ' +
      'applications, so this is an import, not a sync. Re-import to pick up newer conversations.',
    status: 'supported',
  },
};

export const SUPPORTED_CONNECTORS = Object.values(CONNECTORS).filter((c) => c.status === 'supported');
export const EXPERIMENTAL_CONNECTORS = Object.values(CONNECTORS).filter((c) => c.status === 'experimental');

/** Connectors documented but not implemented in this release. */
export const ROADMAP_CONNECTORS: Array<{ label: string; why: string }> = [
  { label: 'GitLab', why: 'Planned. The adapter interface is in place; the API client is not written yet.' },
  { label: 'Vercel', why: 'Planned. Needs deployment-event mapping and an OAuth app.' },
  { label: 'Supabase', why: 'Planned. Needs project and usage metric mapping.' },
  { label: 'Notion', why: 'Planned. Needs an OAuth app and incremental page sync.' },
  { label: 'Google Drive', why: 'Planned. Needs an OAuth app and careful scoping to a single folder.' },
  { label: 'Linear / Jira', why: 'Planned, as project-management adapters.' },
];

export function connectorFor(key: string): Connector | null {
  return (CONNECTORS as Record<string, Connector>)[key] ?? null;
}
