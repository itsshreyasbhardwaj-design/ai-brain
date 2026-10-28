import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuth, getContext } from '@/lib/server';
import { loginAction } from '@/lib/actions';
import { ActionForm, Field, SubmitButton } from '@/components/ui';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ changed?: string }> }) {
  if (await getContext()) redirect('/dashboard');
  if (getAuth().needsSetup()) redirect('/setup');
  const { changed } = await searchParams;

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="display-sm">Sign in</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        To your own brain, on this machine.
      </p>

      {changed && (
        <p className="mt-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--verified)', background: 'var(--verified-dim)', color: 'var(--verified)' }}>
          Password changed. Every other session was signed out.
        </p>
      )}

      <div className="panel-lit mt-6 p-5">
        <ActionForm action={loginAction}>
          <Field label="Email" name="email" type="email" required autoComplete="username" />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" />
          <div className="mt-4">
            <SubmitButton>Sign in</SubmitButton>
          </div>
        </ActionForm>
      </div>

      <p className="mt-6 text-xs leading-relaxed" style={{ color: 'var(--text-ghost)' }}>
        There is no password reset: this installation has no way to email you. If you have lost the
        password, you still have the database file — see <code className="mono">docs/self-hosting.md</code>.
      </p>
      <Link href="/" className="mt-4 text-xs" style={{ color: 'var(--accent)' }}>← Back</Link>
    </main>
  );
}
