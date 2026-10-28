'use client';

/**
 * Interface primitives.
 *
 * Two ideas carry most of the weight here. `Provenance` renders where a value
 * came from next to the value itself, so the interface cannot show a number
 * without saying how it knows. `EmptyState` renders the reason a panel is empty
 * plus the action that would fill it, which is why no surface in this app ever
 * shows a zero it did not measure.
 */

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { ActionResult } from '@/lib/actions';

/* ---------------------------------------------------------------- */
/* Surfaces                                                         */
/* ---------------------------------------------------------------- */

export function Panel({
  title, subtitle, action, children, span = 12, lit = false, className = '',
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  span?: number;
  lit?: boolean;
  className?: string;
}) {
  return (
    <section
      className={`${lit ? 'panel-lit' : 'panel'} p-4 ${className}`}
      style={{ gridColumn: `span ${span} / span ${span}` }}
    >
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium leading-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Chip({
  children, tone = 'neutral', title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'verified' | 'uncertain' | 'accent' | 'danger';
  title?: string;
}) {
  const cls = tone === 'neutral' ? 'chip' : `chip chip-${tone}`;
  return <span className={cls} title={title}>{children}</span>;
}

/**
 * Where a value came from, and how sure we are.
 *
 * 'observed' and 'connector' mean something saw it; 'generated' means a model
 * wrote it. The distinction is always visible, never implied.
 */
export function Provenance({
  origin, confidence, verifiedAt,
}: {
  origin: string;
  confidence?: string;
  verifiedAt?: string | null;
}) {
  const generated = origin === 'generated';
  const derived = origin === 'derived';
  const tone = generated ? 'uncertain' : derived ? 'neutral' : 'verified';
  const label = generated
    ? 'model-written'
    : derived
      ? 'computed from records'
      : origin === 'connector'
        ? 'from a connected source'
        : origin === 'import'
          ? 'imported'
          : 'entered by you';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Chip tone={tone} title={generated ? 'A model wrote this. It is not a verified fact.' : `Origin: ${origin}`}>
        {label}
      </Chip>
      {confidence && confidence !== 'observed' && (
        <Chip tone={confidence === 'low' || confidence === 'unverified' ? 'uncertain' : 'neutral'}>
          {confidence}
        </Chip>
      )}
      {verifiedAt && (
        <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>
          verified {verifiedAt.slice(0, 10)}
        </span>
      )}
    </span>
  );
}

export function EmptyState({ reason, action, href }: { reason: string; action: string; href?: string }) {
  return (
    <div className="empty-state">
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{reason}</p>
      {href ? (
        <Link href={href} className="btn btn-sm mt-2.5">{action} →</Link>
      ) : (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{action}</p>
      )}
    </div>
  );
}

export function Stat({ value, caption, tone }: { value: string; caption: string; tone?: 'accent' | 'uncertain' }) {
  return (
    <div>
      <div
        className="text-2xl font-semibold tracking-tight"
        style={{ color: tone === 'accent' ? 'var(--accent)' : tone === 'uncertain' ? 'var(--uncertain)' : 'var(--text-primary)' }}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{caption}</div>
    </div>
  );
}

export function Meter({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="meter" role="meter" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'progress'}>
        <span style={{ width: `${clamped}%` }} />
      </div>
      {label && <div className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Forms                                                            */
/* ---------------------------------------------------------------- */

export function SubmitButton({
  children, variant = 'primary', size, confirm,
}: {
  children: ReactNode;
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  size?: 'sm';
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  const cls = [
    'btn',
    variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : variant === 'danger' ? 'btn-danger' : '',
    size === 'sm' ? 'btn-sm' : '',
  ].filter(Boolean).join(' ');
  return (
    <button
      type="submit"
      className={cls}
      disabled={pending}
      aria-busy={pending}
      onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

/**
 * A form bound to a Server Action, with its result rendered inline.
 *
 * Progressive enhancement is deliberate: these are real `<form>` posts, so the
 * whole app works with JavaScript disabled.
 */
export function ActionForm({
  action, children, onDone, className = '', resetOnSuccess = false, successRender,
}: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  onDone?: (r: ActionResult) => void;
  className?: string;
  resetOnSuccess?: boolean;
  successRender?: (r: ActionResult) => ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const seen = useRef<ActionResult | null>(null);

  useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onDone?.(state);
    }
  }, [state, resetOnSuccess, onDone]);

  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded-lg border px-3 py-2 text-xs"
          style={{
            borderColor: state.ok ? 'var(--verified)' : 'var(--danger)',
            background: state.ok ? 'var(--verified-dim)' : 'var(--danger-dim)',
            color: state.ok ? 'var(--verified)' : 'var(--danger)',
          }}
        >
          {state.message}
        </div>
      )}
      {state?.ok && successRender?.(state)}
    </form>
  );
}

export function Field({
  label, name, type = 'text', placeholder, required, defaultValue, hint, options, rows, min, max, step, autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  rows?: number;
  min?: number;
  max?: number;
  step?: string;
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="mb-3">
      <label className="label" htmlFor={id}>
        {label}
        {required && <span style={{ color: 'var(--text-ghost)' }}> *</span>}
      </label>
      {options ? (
        <select id={id} name={name} className="select" defaultValue={defaultValue} required={required} aria-describedby={hint ? hintId : undefined}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : type === 'textarea' ? (
        <textarea
          id={id} name={name} className="textarea" placeholder={placeholder} required={required}
          defaultValue={defaultValue} rows={rows ?? 4} aria-describedby={hint ? hintId : undefined}
        />
      ) : (
        <input
          id={id} name={name} type={type} className="input" placeholder={placeholder} required={required}
          defaultValue={defaultValue} min={min} max={max} step={step} autoComplete={autoComplete}
          aria-describedby={hint ? hintId : undefined}
        />
      )}
      {hint && <p id={hintId} className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{hint}</p>}
    </div>
  );
}

export function Checkbox({
  label, name, defaultChecked, hint, value = 'true',
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
  hint?: string;
  value?: string;
}) {
  const id = useId();
  return (
    <div className="mb-3">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
        <input
          id={id} type="checkbox" name={name} value={value} defaultChecked={defaultChecked}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <span>
          <span className="text-sm">{label}</span>
          {hint && <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{hint}</span>}
        </span>
      </label>
    </div>
  );
}

/** A disclosure that stays closed by default, for dense pages. */
export function Disclosure({ summary, children, count }: { summary: string; children: ReactNode; count?: number }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <span className="transition-transform group-open:rotate-90" aria-hidden>▸</span>
        {summary}
        {count !== undefined && <Chip>{count}</Chip>}
      </summary>
      <div className="pt-2 pl-4">{children}</div>
    </details>
  );
}

export function Toast({ message, tone = 'neutral' }: { message: string; tone?: 'neutral' | 'warn' }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-xs"
      style={{
        borderColor: tone === 'warn' ? 'var(--uncertain)' : 'var(--line)',
        background: tone === 'warn' ? 'var(--uncertain-dim)' : 'var(--surface-raised)',
        color: tone === 'warn' ? 'var(--uncertain)' : 'var(--text-secondary)',
      }}
    >
      <span>{message}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Dismiss">×</button>
    </div>
  );
}

/** Shows a secret exactly once, with a copy button and a warning. */
export function RevealOnce({ value, note }: { value: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)' }}>
      <p className="mb-2 text-xs" style={{ color: 'var(--accent)' }}>{note}</p>
      <div className="flex items-center gap-2">
        <code className="mono flex-1 overflow-x-auto rounded border px-2 py-1.5" style={{ background: 'var(--surface-void)', borderColor: 'var(--line)' }}>
          {value}
        </code>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      {label && <div className="eyebrow mb-1.5">{label}</div>}
      <pre
        className="mono overflow-x-auto rounded-lg border p-3 leading-relaxed"
        style={{ background: 'var(--surface-void)', borderColor: 'var(--line)', color: 'var(--text-secondary)' }}
      >
        {code}
      </pre>
      <button
        type="button"
        className="btn btn-sm absolute right-2 top-2"
        style={label ? { top: '1.75rem' } : undefined}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Light/dark toggle. Dark is the designed default; light is a deliberate choice. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const stored = window.localStorage.getItem('ai-brain-theme');
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        document.documentElement.dataset.theme = next;
        window.localStorage.setItem('ai-brain-theme', next);
      }}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
