import { redirect } from 'next/navigation';
import { requireWriteContext } from '@/lib/server';
import { ALL_MODULES } from '@ai-brain/core/engines';

/**
 * Restores an earlier brain configuration.
 *
 * A plain form post rather than a Server Action, so the version-history list
 * works with JavaScript disabled. Restoring writes the old configuration as a
 * new version instead of rolling back, keeping the history append-only.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await requireWriteContext();
  const form = await request.formData();
  const version = Number(form.get('version'));
  if (!Number.isInteger(version) || version < 1) redirect('/onboarding?error=bad-version');

  const old = ctx.store.brainConfig.version(ctx.workspace.id, version);
  if (!old) redirect('/onboarding?error=not-found');

  const saved = ctx.store.brainConfig.save({ ...old, createdBy: 'manual' });
  for (const key of ALL_MODULES) {
    ctx.store.modules.setEnabled(ctx.workspace.id, key, saved.modules.includes(key));
  }
  ctx.store.audit.log({
    workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'brain.restored',
    subject: `brain_configuration:${saved.id}`, detail: { restoredFrom: version, newVersion: saved.version },
  });
  redirect('/onboarding');
}
