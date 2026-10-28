import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuth, configurationWarnings } from '@/lib/server';
import { setupAction } from '@/lib/actions';
import { ActionForm, Field, SubmitButton, Checkbox, Toast } from '@/components/ui';
import { PROFILE_TEMPLATES } from '@ai-brain/core/engines';
import { LATEST_SCHEMA_VERSION } from '@ai-brain/core/db';

export const metadata = { title: 'First-run setup' };

/**
 * First-run setup.
 *
 * Reachable only while no account exists, and it creates everything needed for
 * a working brain in one step: the account, a workspace, and a configuration —
 * so the dashboard is never in an undefined state.
 */
export default function SetupPage() {
  const auth = getAuth();
  if (!auth.needsSetup()) redirect('/login');
  const warnings = configurationWarnings();

  return (
    <main id="main" className="mx-auto max-w-xl px-6 py-16">
      <p className="eyebrow mb-3">First run</p>
      <h1 className="display-sm">Create your account</h1>
      <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        This creates the only account on this installation. It lives in your own database file —
        there is no server to sign up with and nothing is sent anywhere.
      </p>

      <div className="mt-6">
        {warnings.map((w) => <Toast key={w} message={w} tone="warn" />)}
      </div>

      <div className="panel-lit mt-2 p-5">
        <ActionForm action={setupAction}>
          <Field label="Your name" name="displayName" required placeholder="Alex Doe" autoComplete="name" />
          <Field label="Email" name="email" type="email" required placeholder="you@example.com" autoComplete="username" hint="Used only to sign in to this installation." />
          <Field
            label="Password" name="password" type="password" required autoComplete="new-password"
            hint="At least 10 characters. Hashed with scrypt and never stored in plain text."
          />
          <Field label="Name your brain" name="workspaceName" placeholder="My brain" hint="You can change this later." />
          <Field
            label="Where would you like to start?"
            name="profile"
            options={[
              { value: '', label: 'Decide during onboarding' },
              ...Object.values(PROFILE_TEMPLATES).map((p) => ({ value: p.key, label: `${p.label} — ${p.tagline}` })),
            ]}
            hint="A starting point, not a commitment. Every module can be switched on or off afterwards."
          />
          <Field
            label="What do you want help with?"
            name="intents"
            type="textarea"
            rows={3}
            placeholder={'Stop losing track of my side projects\nKnow what my tools actually cost'}
            hint="One per line, or skip it. Your own words are used to decide which modules to switch on."
          />
          <Checkbox
            label="This account belongs to someone under 18"
            name="isMinorAccount"
            hint="Keeps remote AI off and keeps academic material local."
          />
          <div className="mt-5 flex items-center gap-3">
            <SubmitButton>Create account</SubmitButton>
            <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>
              Database schema v{LATEST_SCHEMA_VERSION}
            </span>
          </div>
        </ActionForm>
      </div>

      <p className="mt-6 text-xs" style={{ color: 'var(--text-ghost)' }}>
        Already set up on another machine? Create an account here, then import your{' '}
        <code className="mono">brain.config.json</code> and export file from{' '}
        <Link href="/settings" style={{ color: 'var(--accent)' }}>Settings</Link>.
      </p>
    </main>
  );
}
