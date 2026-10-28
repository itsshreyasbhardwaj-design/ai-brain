import { requireContext, engines, configurationWarnings } from '@/lib/server';
import { logoutAction } from '@/lib/actions';
import { Shell } from '@/components/shell';
import { Toast } from '@/components/ui';
import { daysBetween, nowIso } from '@ai-brain/core';

/** Every authenticated page renders inside the shell. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const accounts = ctx.store.accounts.list(ctx.workspace.id);

  const counts = {
    pendingReview: ctx.store.projects.list(ctx.workspace.id, { reviewState: ['pending-review'], limit: 1000 }).length,
    staleConnections: accounts.filter(
      (a) => a.status === 'error' || (a.lastSyncAt !== null && daysBetween(a.lastSyncAt, nowIso()) > 7),
    ).length,
  };
  const warnings = configurationWarnings();

  return (
    <Shell
      modules={ctx.config?.modules ?? ctx.store.modules.enabledKeys(ctx.workspace.id)}
      brainName={ctx.config?.displayName ?? ctx.workspace.name}
      userName={ctx.user.displayName}
      counts={counts}
      logout={logoutAction}
    >
      {warnings.map((w) => <Toast key={w} message={w} tone="warn" />)}
      {children}
    </Shell>
  );
}
