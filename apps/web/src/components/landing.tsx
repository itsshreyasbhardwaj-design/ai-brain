'use client';

/**
 * Landing-page motion.
 *
 * Scroll-driven reveal and a light parallax on the core visual. Both are
 * progressive: with JavaScript off the scenes render visible, and with
 * `prefers-reduced-motion` the observer marks everything visible immediately
 * and the parallax never runs.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export function LandingScenes({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scenes = root.current?.querySelectorAll<HTMLElement>('[data-scene]');
    if (!scenes || scenes.length === 0) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      scenes.forEach((s) => { s.dataset.visible = 'true'; });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.visible = 'true';
            // One-way: a scene that has been read should not fade out again.
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '-12% 0px -12% 0px', threshold: 0.05 },
    );
    scenes.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return <div ref={root}>{children}</div>;
}

/**
 * The AI BRAIN core: concentric rings, a breathing glow, and orbiting domain
 * markers. CSS and SVG rather than WebGL, because the landing page should not
 * pay for a 3D runtime before anyone has signed in.
 */
export function CoreVisual() {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const progress = (rect.top + rect.height / 2 - window.innerHeight / 2) / window.innerHeight;
        el.style.transform = `translateY(${(-progress * 26).toFixed(2)}px)`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={wrap} className="parallax relative mx-auto aspect-square w-full max-w-md" aria-hidden>
      <div className="core-glow" />
      <svg viewBox="0 0 400 400" className="relative size-full">
        <defs>
          <radialGradient id="coreFill" cx="50%" cy="42%" r="60%">
            <stop offset="0%" stopColor="#61d7e8" stopOpacity="0.85" />
            <stop offset="55%" stopColor="#26323d" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#080b10" stopOpacity="1" />
          </radialGradient>
          <linearGradient id="ringStroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#61d7e8" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#61d7e8" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* Orbits */}
        {[190, 155, 120].map((r, i) => (
          <circle
            key={r}
            cx="200" cy="200" r={r}
            fill="none"
            stroke="url(#ringStroke)"
            strokeWidth={i === 0 ? 0.75 : 1}
            strokeDasharray={i === 1 ? '3 7' : undefined}
          />
        ))}

        {/* Domain markers, one per module family */}
        {[
          { a: 0, r: 190, label: 'projects' },
          { a: 52, r: 155, label: 'knowledge' },
          { a: 120, r: 190, label: 'resources' },
          { a: 186, r: 120, label: 'goals' },
          { a: 240, r: 155, label: 'decisions' },
          { a: 305, r: 190, label: 'activity' },
        ].map(({ a, r, label }) => {
          const rad = (a * Math.PI) / 180;
          const x = 200 + Math.cos(rad) * r;
          const y = 200 + Math.sin(rad) * r;
          return (
            <g key={label}>
              <line x1="200" y1="200" x2={x} y2={y} stroke="#26323d" strokeWidth="0.75" strokeOpacity="0.55" />
              <circle cx={x} cy={y} r="5" fill="#0e141b" stroke="#61d7e8" strokeWidth="1.25" />
              <circle cx={x} cy={y} r="1.75" fill="#61d7e8" />
            </g>
          );
        })}

        {/* The core */}
        <circle cx="200" cy="200" r="62" fill="url(#coreFill)" />
        <circle cx="200" cy="200" r="62" fill="none" stroke="#61d7e8" strokeWidth="1" strokeOpacity="0.4" />
        <circle cx="200" cy="200" r="78" fill="none" stroke="#61d7e8" strokeWidth="0.75" strokeOpacity="0.14" />

        {/* Facets, to read as a cut stone rather than a flat disc */}
        {Array.from({ length: 12 }, (_, i) => {
          const rad = (i * 30 * Math.PI) / 180;
          return (
            <line
              key={i}
              x1={200 + Math.cos(rad) * 24} y1={200 + Math.sin(rad) * 24}
              x2={200 + Math.cos(rad) * 61} y2={200 + Math.sin(rad) * 61}
              stroke="#080b10" strokeWidth="0.75" strokeOpacity="0.5"
            />
          );
        })}
      </svg>
    </div>
  );
}
