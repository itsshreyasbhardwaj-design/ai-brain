import Link from 'next/link';
import { requireContext } from '@/lib/server';
import { saveBrainAction } from '@/lib/actions';
import { OnboardingForm } from '@/components/onboarding-form';
import { PROFILE_TEMPLATES, MODULE_INFO, ALL_MODULES } from '@ai-brain/core/engines';
import { CONNECTORS } from '@ai-brain/core/connectors';
import { toConfigFile } from '@ai-brain/core/engines';

export const metadata = { title: 'Build your brain' };

/**
 * Onboarding.
 *
 * Doubles as the permanent configuration editor: the same form that builds a
 * brain is the one that edits it, so there is no second code path that can
 * drift. Every answer is optional.
 */
export default async function OnboardingPage() {
  const ctx = await requireContext();
  const current = ctx.config;
  const history = ctx.store.brainConfig.history(ctx.workspace.id);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow mb-2">{current ? `Version ${current.version}` : 'Onboarding'}</p>
        <h1 className="display-sm">{current ? 'Your brain' : 'Build your brain'}</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Nothing here is required, and nothing is permanent. Saving writes a new version and keeps the
          old ones, and changing your profile never moves or deletes a record.
        </p>
      </header>

      <OnboardingForm
        action={saveBrainAction}
        profiles={Object.values(PROFILE_TEMPLATES).map((p) => ({
          key: p.key, label: p.label, tagline: p.tagline, audience: p.audience,
          modules: p.modules, categories: p.knowledgeCategories,
        }))}
        modules={ALL_MODULES.map((key) => ({ key, ...MODULE_INFO[key] }))}
        connectors={Object.values(CONNECTORS).map((c) => ({ key: c.key, label: c.label, status: c.status, mode: c.mode }))}
        current={current ? toConfigFile(current) : null}
        isMinor={ctx.user.isMinorAccount}
      />

      {history.length > 1 && (
        <section className="panel mt-6 p-4">
          <h2 className="mb-3 text-sm font-medium">Version history</h2>
          <ul className="space-y-1.5 text-xs">
            {history.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3">
                <span style={{ color: 'var(--text-secondary)' }}>
                  v{v.version} · {v.profile} · {v.modules.length} modules · {v.createdAt.slice(0, 10)}
                  <span className="ml-1.5" style={{ color: 'var(--text-ghost)' }}>({v.createdBy})</span>
                </span>
                {v.version !== current?.version && (
                  <form action="/api/restore-config" method="post">
                    <input type="hidden" name="version" value={v.version} />
                    <button type="submit" className="btn btn-sm">Restore</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
            Restoring writes the old configuration as a new version rather than rolling back, so the
            history stays append-only.
          </p>
        </section>
      )}

      <div className="mt-8 flex items-center gap-3">
        <Link href="/dashboard" className="btn">Go to Mission Control →</Link>
        <Link href="/integrations" className="btn btn-ghost">Connect a source</Link>
      </div>
    </main>
  );
}
