'use client';

/**
 * The application shell: sidebar, command palette and quick actions.
 *
 * Navigation is keyboard-first because this is a tool people open many times a
 * day: ⌘K opens the palette, g-then-a-letter jumps between sections, and every
 * nav item is a real link so it works without any of that.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeToggle } from './ui';
import type { ModuleKey } from '@ai-brain/core/domain';

interface NavItem {
  href: string;
  label: string;
  /** Hidden when this module is off. */
  module?: ModuleKey;
  /** Second key in the `g` chord. */
  key?: string;
  badge?: number;
}

export function Shell({
  children, modules, brainName, userName, counts, logout,
}: {
  children: React.ReactNode;
  modules: ModuleKey[];
  brainName: string;
  userName: string;
  counts: { pendingReview: number; staleConnections: number };
  logout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const items: NavItem[] = ([
    { href: '/dashboard', label: 'Mission Control', key: 'd' },
    { href: '/universe', label: 'Universe', key: 'u' },
    { href: '/projects', label: 'Projects', module: 'projects', key: 'p', badge: counts.pendingReview },
    { href: '/knowledge', label: 'Knowledge', module: 'knowledge', key: 'k' },
    { href: '/tasks', label: 'Tasks', module: 'tasks', key: 't' },
    { href: '/goals', label: 'Goals', module: 'goals', key: 'g' },
    { href: '/decisions', label: 'Decisions', module: 'decisions', key: 'e' },
    { href: '/resources', label: 'Resources', module: 'resources', key: 'r' },
    { href: '/assistant', label: 'Assistant', module: 'assistant', key: 'a' },
    { href: '/reports', label: 'Reviews', module: 'reports', key: 'v' },
    { href: '/integrations', label: 'Integrations', module: 'integrations', key: 'i', badge: counts.staleConnections },
    { href: '/settings', label: 'Settings', key: 's' },
  ] satisfies NavItem[]).filter((i) => !i.module || modules.includes(i.module));

  // ⌘K / Ctrl-K for the palette; `g` then a letter to jump.
  useEffect(() => {
    let chord = false;
    let timer: ReturnType<typeof setTimeout>;

    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (typing) return;

      if (chord) {
        const match = items.find((i) => i.key === e.key.toLowerCase());
        chord = false;
        clearTimeout(timer);
        if (match) {
          e.preventDefault();
          router.push(match.href);
        }
        return;
      }
      if (e.key === 'g') {
        chord = true;
        timer = setTimeout(() => { chord = false; }, 1400);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [items, router]);

  return (
    <div className="shell">
      <nav
        className="border-r px-3 py-4 max-lg:hidden"
        style={{ borderColor: 'var(--line)', background: 'var(--surface-void)' }}
        aria-label="Main"
      >
        <div className="mb-6 px-2">
          <Link href="/dashboard" className="flex items-center gap-2 no-underline">
            <CoreMark />
            <span className="text-sm font-semibold tracking-tight">AI BRAIN</span>
          </Link>
          <p className="mt-1.5 truncate text-[11px]" style={{ color: 'var(--text-ghost)' }}>{brainName}</p>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mb-4 flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs"
          style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-base)', color: 'var(--text-tertiary)' }}
        >
          <span>Jump to…</span>
          <kbd className="mono text-[10px]" style={{ color: 'var(--text-ghost)' }}>⌘K</kbd>
        </button>

        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] no-underline transition-colors"
                  style={{
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: active ? 560 : 440,
                  }}
                >
                  <span>{item.label}</span>
                  {item.badge ? <span className="chip chip-uncertain">{item.badge}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--line-subtle)' }}>
          <p className="px-2.5 text-[11px]" style={{ color: 'var(--text-ghost)' }}>{userName}</p>
          <div className="mt-2 flex items-center gap-1 px-1">
            <ThemeToggle />
            <form action={logout}>
              <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
            </form>
          </div>
        </div>
      </nav>

      {/* Mobile header */}
      <header
        className="glass sticky top-0 z-30 flex items-center justify-between border-b px-4 py-2.5 lg:hidden"
        style={{ borderColor: 'var(--line)' }}
      >
        <Link href="/dashboard" className="flex items-center gap-2 no-underline">
          <CoreMark />
          <span className="text-sm font-semibold">AI BRAIN</span>
        </Link>
        <div className="flex items-center gap-1">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaletteOpen(true)} aria-label="Search">⌘K</button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
          >
            Menu
          </button>
        </div>
      </header>

      {mobileOpen && (
        <nav id="mobile-nav" className="border-b px-4 py-3 lg:hidden" style={{ borderColor: 'var(--line)', background: 'var(--surface-void)' }} aria-label="Main">
          <ul className="grid grid-cols-2 gap-1">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-lg px-2.5 py-2 text-[13px] no-underline"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {item.label}
                  {item.badge ? <span className="chip chip-uncertain ml-1.5">{item.badge}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
          <form action={logout} className="mt-2">
            <button type="submit" className="btn btn-sm w-full">Sign out</button>
          </form>
        </nav>
      )}

      <main id="main" className="min-w-0 px-4 py-6 lg:px-8 lg:py-8">{children}</main>

      {paletteOpen && <Palette items={items} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function CoreMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.75" fill="var(--accent)" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="var(--line-strong)" strokeWidth="1.5" />
    </svg>
  );
}

/** Fuzzy-ish navigation palette, also used for direct search. */
function Palette({ items, onClose }: { items: NavItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const results = items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()));
  const searchHref = query.trim() ? `/knowledge?q=${encodeURIComponent(query.trim())}` : null;
  const total = results.length + (searchHref ? 1 : 0);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);

  const go = useCallback((i: number): void => {
    if (searchHref && i === results.length) { router.push(searchHref); onClose(); return; }
    const item = results[i];
    if (item) { router.push(item.href); onClose(); }
  }, [results, searchHref, router, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]"
      style={{ background: 'rgb(5 7 9 / 0.72)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="panel-lit w-full max-w-lg overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a section, or search your knowledge…"
          className="w-full border-0 bg-transparent px-4 py-3.5 text-sm outline-none"
          style={{ color: 'var(--text-primary)' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % Math.max(1, total)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + total) % Math.max(1, total)); }
            if (e.key === 'Enter') { e.preventDefault(); go(index); }
          }}
        />
        <ul className="max-h-80 overflow-y-auto border-t py-1.5" style={{ borderColor: 'var(--line)' }}>
          {results.map((item, i) => (
            <li key={item.href}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-2 text-left text-sm"
                style={{ background: i === index ? 'var(--surface-raised)' : 'transparent' }}
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(i)}
              >
                <span>{item.label}</span>
                {item.key && <kbd className="mono text-[10px]" style={{ color: 'var(--text-ghost)' }}>g {item.key}</kbd>}
              </button>
            </li>
          ))}
          {searchHref && (
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                style={{ background: index === results.length ? 'var(--surface-raised)' : 'transparent' }}
                onMouseEnter={() => setIndex(results.length)}
                onClick={() => go(results.length)}
              >
                <span style={{ color: 'var(--accent)' }}>Search knowledge for</span>
                <span className="truncate">“{query.trim()}”</span>
              </button>
            </li>
          )}
          {total === 0 && (
            <li className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>Nothing matches that.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
