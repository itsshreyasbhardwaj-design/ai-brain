'use client';

/**
 * Issuing an access token.
 *
 * Lives in its own client component because the result needs custom rendering
 * — the raw token shown exactly once, plus a ready-to-paste MCP config — and a
 * render function cannot cross the server/client boundary as a prop.
 */

import { ActionForm, Field, SubmitButton, Checkbox, RevealOnce, CodeBlock } from './ui';
import { issueTokenAction } from '@/lib/actions';

const SCOPES = [
  ['brain:read', 'Read the brain profile, dashboard, priorities and reviews'],
  ['projects:read', 'Read projects and their passports'],
  ['knowledge:read', 'Read and search knowledge records and decisions'],
  ['activity:read', 'Read recorded activity'],
  ['resources:read', 'Read recorded time and cost'],
  ['propose:write', 'Propose changes for you to accept (cannot change anything directly)'],
] as const;

export function TokenForm({ dbPath }: { dbPath: string }) {
  return (
    <ActionForm
      action={issueTokenAction}
      resetOnSuccess
      successRender={(r) => {
        const token = r.data?.token as string | undefined;
        if (!token) return null;
        return (
          <>
            <RevealOnce value={token} note="Copy this now. Only its hash is stored, so it cannot be shown again." />
            <div className="mt-3">
              <CodeBlock
                label="Point an MCP client at your brain"
                code={JSON.stringify(
                  {
                    mcpServers: {
                      'ai-brain': {
                        command: 'node',
                        args: ['tools/mcp-server/src/index.ts'],
                        env: { AI_BRAIN_DB: dbPath, AI_BRAIN_TOKEN: token },
                      },
                    },
                  },
                  null,
                  2,
                )}
              />
            </div>
          </>
        );
      }}
    >
      <Field label="What is it for?" name="label" required placeholder="Claude Code on my laptop" />
      <fieldset className="mb-3">
        <legend className="label">Scopes</legend>
        {SCOPES.map(([scope, description]) => (
          <Checkbox
            key={scope}
            name="scopes[]"
            value={scope}
            label={scope}
            hint={description}
            defaultChecked={scope !== 'propose:write'}
          />
        ))}
      </fieldset>
      <Field label="Expires after (days)" name="days" type="number" min={1} max={3650} hint="Leave blank for no expiry." />
      <SubmitButton>Issue token</SubmitButton>
    </ActionForm>
  );
}
