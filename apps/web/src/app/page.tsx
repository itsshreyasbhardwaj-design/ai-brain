import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuth, getContext } from '@/lib/server';
import { CONNECTORS, ROADMAP_CONNECTORS } from '@ai-brain/core/connectors';
import { PROFILE_TEMPLATES } from '@ai-brain/core/engines';
import { LandingScenes, CoreVisual } from '@/components/landing';

/**
 * The landing page.
 *
 * A self-hosted installation does not need marketing, so this does two things
 * instead: it shows the product honestly to someone evaluating the repository,
 * and it gets an existing user to their dashboard in one click. Anyone already
 * signed in is redirected straight past it.
 */
export default async function Landing() {
  const ctx = await getContext();
  if (ctx) redirect('/dashboard');
  const needsSetup = getAuth().needsSetup();

  const supported = Object.values(CONNECTORS).filter((c) => c.status === 'supported');
  const experimental = Object.values(CONNECTORS).filter((c) => c.status === 'experimental');

  return (
    <main id="main">
      {/* Scene 1 — Your intelligence, centralised */}
      <section className="relative flex min-h-[92dvh] items-center overflow-hidden px-6">
        <div className="hairline-grid pointer-events-none absolute inset-0 opacity-70" aria-hidden />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 py-20 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rise">
            <p className="eyebrow mb-5">Open-source personal intelligence</p>
            <h1 className="display">
              Your work,
              <br />
              <span style={{ color: 'var(--accent)' }}>actually organised.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              AI BRAIN finds the projects you are really working on, keeps the context you have already
              written down, and tells you where your time and money are going — from evidence, not guesses.
            </p>
            <p className="mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              It runs on your machine, stores everything in one file you own, and works with no API keys
              and no paid services.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={needsSetup ? '/setup' : '/login'} className="btn btn-primary">
                {needsSetup ? 'Build your brain' : 'Sign in'}
              </Link>
              <Link href="#how" className="btn">See how it works</Link>
            </div>
            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6">
              {[
                ['0', 'paid services required'],
                ['1', 'file holds everything'],
                ['0', 'dependencies in the core'],
              ].map(([value, label]) => (
                <div key={label}>
                  <dt className="text-2xl font-semibold" style={{ color: 'var(--accent)' }}>{value}</dt>
                  <dd className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
          <CoreVisual />
        </div>
      </section>

      <LandingScenes>
        {/* Scene 2 — Your information universe */}
        <Scene
          eyebrow="Scene 02"
          title="One system, the parts you need"
          lead="A brain is assembled from modules. Switch on what helps; the rest stays out of your way. Changing your mind later never moves or deletes a record."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.values(PROFILE_TEMPLATES).filter((p) => p.key !== 'custom').map((p) => (
              <div key={p.key} className="panel p-4">
                <h3 className="text-sm font-medium">{p.label}</h3>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{p.tagline}</p>
                <p className="mt-2.5 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                  {p.modules.length} modules
                </p>
              </div>
            ))}
          </div>
        </Scene>

        {/* Scene 3 — Connect your world */}
        <Scene
          eyebrow="Scene 03"
          title="Connect only what you authorize"
          lead="Each connector says exactly what it can and cannot do, in the product and in this list. Nothing is read from an account you have not allowlisted."
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {[...supported, ...experimental].map((c) => (
              <div key={c.key} className="panel p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">{c.label}</h3>
                  <span className={c.status === 'supported' ? 'chip chip-verified' : 'chip chip-uncertain'}>{c.status}</span>
                  <span className="chip">{c.mode}</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{c.limitations}</p>
              </div>
            ))}
          </div>
          <div className="panel mt-3 p-4">
            <h3 className="eyebrow mb-2">Not in this release</h3>
            <ul className="grid gap-1.5 text-xs sm:grid-cols-2" style={{ color: 'var(--text-tertiary)' }}>
              {ROADMAP_CONNECTORS.map((r) => (
                <li key={r.label}>
                  <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span> — {r.why}
                </li>
              ))}
            </ul>
          </div>
        </Scene>

        {/* Scene 4 — Discover what matters */}
        <Scene
          id="how"
          eyebrow="Scene 04"
          title="Projects find themselves"
          lead="Point AI BRAIN at a source and it works out what is actually a project, what is a rename of something you already have, and what it is not sure about."
        >
          <ol className="grid gap-3 md:grid-cols-3">
            {[
              ['Observe', 'A connector reports what it sees, with a stable provider identifier — never a name alone.'],
              ['Resolve', 'Identity rules decide: known project, rename, fork, monorepo member, or genuinely new. Each gets a confidence score.'],
              ['Decide', 'High confidence registers itself. Anything ambiguous waits in a review queue, because a wrong merge is worse than a question.'],
            ].map(([title, body], i) => (
              <li key={title} className="panel-lit p-4">
                <span className="mono" style={{ color: 'var(--accent)' }}>0{i + 1}</span>
                <h3 className="mt-1.5 text-sm font-medium">{title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{body}</p>
              </li>
            ))}
          </ol>
        </Scene>

        {/* Scene 5 — Understand and improve */}
        <Scene
          eyebrow="Scene 05"
          title="It tells you what it does not know"
          lead="The hardest promise in a system like this is restraint. An empty panel says why it is empty. A model-written line says a model wrote it. A number always says where it came from."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="panel p-4">
              <h3 className="mb-3 text-sm font-medium">What you get with nothing connected</h3>
              <ul className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {[
                  'Projects, goals, tasks, decisions and a searchable knowledge base',
                  'Full-text search over everything you import',
                  'Rule-based reviews, priorities and recommendations',
                  'Resource tracking from figures you record',
                  'The spatial universe and a complete 2D equivalent',
                  'Export of everything, any time',
                ].map((x) => (
                  <li key={x} className="flex gap-2">
                    <span aria-hidden style={{ color: 'var(--verified)' }}>✓</span>{x}
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel p-4">
              <h3 className="mb-3 text-sm font-medium">What an AI provider adds</h3>
              <ul className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <li className="flex gap-2"><span aria-hidden style={{ color: 'var(--accent)' }}>+</span>Answers rephrased in prose instead of structured output</li>
              </ul>
              <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                That is the whole list. A provider may only rewrite an answer the system already computed —
                it is never asked what is true. There is no provider configured by default, a key alone does
                not authorize spending, and a local model through Ollama costs nothing at all.
              </p>
            </div>
          </div>
        </Scene>

        {/* Scene 6 — Build your AI BRAIN */}
        <Scene eyebrow="Scene 06" title="Build yours" lead="Six questions, none of them required. You can skip the lot and change everything later.">
          <div className="panel-lit p-6 text-center">
            <p className="mx-auto max-w-lg text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Your data stays in <code className="mono">./data/brain.db</code>. No account on anyone else's
              server, no telemetry, and an export button that gives you everything.
            </p>
            <Link href={needsSetup ? '/setup' : '/login'} className="btn btn-primary mt-5">
              {needsSetup ? 'Start the first-run setup' : 'Sign in'}
            </Link>
          </div>
        </Scene>
      </LandingScenes>

      <footer className="border-t px-6 py-8" style={{ borderColor: 'var(--line)' }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-xs" style={{ color: 'var(--text-ghost)' }}>
          <span>AI BRAIN · Apache-2.0 · local-first and self-hostable</span>
          <span>Nothing on this page is tracked. There is no analytics code in this application.</span>
        </div>
      </footer>
    </main>
  );
}

function Scene({
  id, eyebrow, title, lead, children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scene border-t px-6 py-24" style={{ borderColor: 'var(--line-subtle)' }} data-scene>
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h2 className="display-sm max-w-2xl">{title}</h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{lead}</p>
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}
