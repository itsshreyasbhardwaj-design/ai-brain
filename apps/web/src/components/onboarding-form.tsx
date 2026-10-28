'use client';

/**
 * The brain builder.
 *
 * Picking a profile previews its modules immediately so the choice is legible
 * before it is made, and switching to a custom set never loses that preview —
 * the checkboxes are the single source of truth for what gets saved.
 */

import { useState } from 'react';
import { ActionForm, Field, SubmitButton, Checkbox, Disclosure } from './ui';
import type { ActionResult } from '@/lib/actions';

interface ProfileOption {
  key: string;
  label: string;
  tagline: string;
  audience: string;
  modules: string[];
  categories: string[];
}

interface ModuleOption {
  key: string;
  label: string;
  description: string;
}

interface ConnectorOption {
  key: string;
  label: string;
  status: string;
  mode: string;
}

export function OnboardingForm({
  action, profiles, modules, connectors, current, isMinor,
}: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  profiles: ProfileOption[];
  modules: ModuleOption[];
  connectors: ConnectorOption[];
  current: {
    profile: string;
    displayName: string;
    intents: string[];
    modules: string[];
    goalHierarchy: Array<{ title: string }>;
    reportingCadence: string;
    automationLevel: string;
    workingStyle: string;
    assistantInstructions: string;
    privacy: {
      allowRemoteAi: boolean;
      allowFileContentImport: boolean;
      excludedCategories: string[];
      excludedPaths: string[];
      sourceRetentionDays: number;
    };
  } | null;
  isMinor: boolean;
}) {
  const [profile, setProfile] = useState(current?.profile ?? '');
  const selectedProfile = profiles.find((p) => p.key === profile);
  const [enabled, setEnabled] = useState<string[]>(current?.modules ?? profiles.find((p) => p.key === 'personal')!.modules);

  /** Choosing a profile replaces the module set with that profile's preset. */
  const chooseProfile = (key: string): void => {
    setProfile(key);
    const preset = profiles.find((p) => p.key === key);
    if (preset && key !== 'custom') setEnabled(preset.modules);
  };

  return (
    <ActionForm
      action={action}
      successRender={(r) => {
        const rationale = (r.data?.rationale as string[] | undefined) ?? [];
        if (rationale.length === 0) return null;
        return (
          <div className="panel mt-4 p-4">
            <h3 className="eyebrow mb-2">Why your brain looks like this</h3>
            <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {rationale.map((line, i) => <li key={i}>· {line}</li>)}
            </ul>
          </div>
        );
      }}
    >
      {/* Step 1 — profile */}
      <section className="panel-lit mb-4 p-5">
        <h2 className="mb-1 text-sm font-medium">1 · Where do you want to start?</h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          A preset over one shared architecture. Pick the closest, then adjust.
        </p>
        <input type="hidden" name="profile" value={profile || 'personal'} />
        <div className="grid gap-2 sm:grid-cols-2">
          {profiles.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => chooseProfile(p.key)}
              aria-pressed={profile === p.key}
              className="rounded-lg border p-3 text-left transition-colors"
              style={{
                borderColor: profile === p.key ? 'var(--accent)' : 'var(--line)',
                background: profile === p.key ? 'var(--accent-dim)' : 'var(--surface-raised)',
              }}
            >
              <span className="block text-[13px] font-medium">{p.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {p.tagline}
              </span>
            </button>
          ))}
        </div>
        {selectedProfile && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {selectedProfile.audience}
          </p>
        )}
      </section>

      {/* Step 2 — in their own words */}
      <section className="panel mb-4 p-5">
        <h2 className="mb-1 text-sm font-medium">2 · What do you want help with?</h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Your own words. These switch extra modules on when they clearly imply one, and the result
          explains which and why.
        </p>
        <Field label="Name your brain" name="displayName" defaultValue={current?.displayName ?? ''} placeholder="My brain" />
        <Field
          label="What should it help with?"
          name="intents"
          type="textarea"
          rows={3}
          defaultValue={current?.intents.join('\n') ?? ''}
          placeholder={'Stop losing track of side projects\nKnow what my tools cost\nRemember why I made decisions'}
          hint="One per line."
        />
        <Field
          label="Projects you are working on now"
          name="currentProjects"
          type="textarea"
          rows={3}
          placeholder={'ai-brain\nClient website redesign'}
          hint="One per line. These are created as projects you can fill in later."
        />
        <Field
          label="Goals for this quarter"
          name="primaryGoals"
          type="textarea"
          rows={2}
          defaultValue={current?.goalHierarchy.map((g) => g.title).join('\n') ?? ''}
          hint="One per line. Leave blank to use your profile's starting goals."
        />
      </section>

      {/* Step 3 — modules */}
      <section className="panel mb-4 p-5">
        <h2 className="mb-1 text-sm font-medium">3 · Which modules?</h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {enabled.length} of {modules.length} switched on. Turning one off hides it; nothing is deleted,
          and the records come back if you turn it on again.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {modules.map((m) => (
            <label
              key={m.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5"
              style={{
                borderColor: enabled.includes(m.key) ? 'var(--accent)' : 'var(--line)',
                background: enabled.includes(m.key) ? 'var(--accent-dim)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                name="modules[]"
                value={m.key}
                checked={enabled.includes(m.key)}
                onChange={(e) => {
                  setEnabled((prev) => (e.target.checked ? [...prev, m.key] : prev.filter((k) => k !== m.key)));
                  if (profile !== 'custom') setProfile('custom');
                }}
                className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                <span className="block text-[13px]">{m.label}</span>
                <span className="block text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                  {m.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Step 4 — working style */}
      <section className="panel mb-4 p-5">
        <h2 className="mb-4 text-sm font-medium">4 · How do you work?</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Working style" name="workingStyle" defaultValue={current?.workingStyle ?? 'balanced'}
            options={[
              { value: 'deep-work', label: 'Long focused blocks' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'reactive', label: 'Reactive, many interruptions' },
            ]}
          />
          <Field
            label="Review cadence" name="reportingCadence" defaultValue={current?.reportingCadence ?? 'weekly'}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
              { value: 'quarterly', label: 'Quarterly' },
              { value: 'manual', label: 'Only when I ask' },
            ]}
            hint="Reviews are run by you. Nothing is scheduled automatically."
          />
          <Field
            label="Discovered projects" name="automationLevel" defaultValue={current?.automationLevel ?? 'review'}
            options={[
              { value: 'manual', label: 'I add them myself' },
              { value: 'review', label: 'Queue them for my approval' },
              { value: 'automatic', label: 'Register confident ones' },
            ]}
            hint="Ambiguous matches always wait for you, whatever this is set to."
          />
        </div>
      </section>

      {/* Step 5 — privacy */}
      <section className="panel mb-4 p-5" style={{ borderColor: 'var(--line-strong)' }}>
        <h2 className="mb-1 text-sm font-medium">5 · Privacy</h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Everything is off by default. These settings are enforced in the engine, not just in the
          interface.
        </p>
        <Checkbox
          label="Allow sending my data to a remote AI provider"
          name="allowRemoteAi"
          defaultChecked={isMinor ? false : current?.privacy.allowRemoteAi ?? false}
          hint={
            isMinor
              ? 'Unavailable: this account is marked as belonging to a minor.'
              : 'Off by default. With this off, every feature still works — answers are computed by rules instead of written by a model. A local model through Ollama needs no key and no network.'
          }
        />
        <Checkbox
          label="Import the contents of files, not just their names"
          name="allowFileContentImport"
          defaultChecked={current?.privacy.allowFileContentImport ?? true}
          hint="Secrets are stripped locally before anything is stored, either way."
        />
        <Field
          label="Never import anything tagged or titled with these"
          name="excludedCategories"
          defaultValue={current?.privacy.excludedCategories.join(', ') ?? ''}
          placeholder="health, finance, personal"
          hint="Comma separated. Matching documents are skipped entirely."
        />
        <Field
          label="Never read these paths"
          name="excludedPaths"
          type="textarea"
          rows={2}
          defaultValue={current?.privacy.excludedPaths.join('\n') ?? ''}
          placeholder={'/Users/me/private/**\n**/secrets/**'}
          hint="One glob per line. This is on top of a built-in denylist that always blocks .env files, SSH keys, credential files and node_modules."
        />
        <Field
          label="Discard raw source payloads after this many days"
          name="sourceRetentionDays"
          type="number"
          min={0}
          max={3650}
          defaultValue={current?.privacy.sourceRetentionDays ?? 0}
          hint="0 keeps them. Either way, the provenance record stays so claims remain traceable."
        />
      </section>

      <Disclosure summary="Assistant instructions (optional)">
        <Field
          label="What should an AI assistant know about how you work?"
          name="assistantInstructions"
          type="textarea"
          rows={4}
          defaultValue={current?.assistantInstructions ?? ''}
          hint="Handed to any assistant that reads your brain over MCP, alongside instructions that it must not state anything your records do not support."
        />
      </Disclosure>

      <Disclosure summary="Connectors this profile suggests">
        <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {connectors.map((c) => (
            <li key={c.key}>
              {c.label} <span className="chip">{c.status}</span> <span className="chip">{c.mode}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
          Nothing is connected by saving this. You authorize each one yourself under Integrations.
        </p>
      </Disclosure>

      <div className="mt-6">
        <SubmitButton>{current ? 'Save as a new version' : 'Build my brain'}</SubmitButton>
      </div>
    </ActionForm>
  );
}
