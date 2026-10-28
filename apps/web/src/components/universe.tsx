'use client';

/**
 * The 3D Personal Intelligence Universe.
 *
 * Built directly on three.js rather than a React renderer: the scene is a flat
 * list of instanced nodes and line segments that changes only when the data
 * changes, so a declarative wrapper would cost more than it saves.
 *
 * Three rules shape what gets drawn:
 *   - every node is a real record, and every edge is a stored relationship or
 *     an explicit containment. Nothing is connected for visual effect;
 *   - visual encoding carries meaning — distance from the core is domain,
 *     size is recorded activity, colour is lifecycle, and an unconfirmed
 *     discovery is drawn hollow;
 *   - the 2D view below is a complete alternative, not a degraded one. It is
 *     what renders when WebGL is unavailable, when reduced motion is set, or
 *     whenever the user prefers it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

export interface UniverseNode {
  id: string;
  label: string;
  /** 'core' | 'domain' | 'project' | 'cluster' */
  kind: 'core' | 'domain' | 'project' | 'cluster';
  /** Domain this belongs to, for grouping. */
  domain: string;
  /** 0-1, from recorded activity. Drives size. */
  weight: number;
  lifecycle: string;
  /** Unconfirmed discoveries are drawn hollow. */
  unconfirmed: boolean;
  href?: string;
  detail: string[];
}

export interface UniverseEdge {
  from: string;
  to: string;
  /** 'contains' for structure, or the stored relationship kind. */
  kind: string;
  /** Edges we are not certain about are drawn fainter. */
  certain: boolean;
}

export interface UniverseData {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  generatedAt: string;
  emptyReason?: string;
}

const LIFECYCLE_COLORS: Record<string, number> = {
  active: 0x61d7e8,
  shipped: 0x55d5aa,
  blocked: 0xe8737d,
  paused: 0xd7b98a,
  planning: 0x9fb0bd,
  idea: 0x9fb0bd,
  archived: 0x475764,
};

export function Universe({ data }: { data: UniverseData }) {
  const [mode, setMode] = useState<'3d' | '2d'>('3d');
  const [selected, setSelected] = useState<UniverseNode | null>(null);
  const [query, setQuery] = useState('');
  const [webglFailed, setWebglFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const stored = window.localStorage.getItem('ai-brain-universe-mode');
    if (stored === '2d' || stored === '3d') setMode(stored);
    else if (mq.matches) setMode('2d');
  }, []);

  const filtered = useMemo(() => {
    if (query.trim() === '') return data;
    const q = query.toLowerCase();
    const keep = new Set(
      data.nodes.filter((n) => n.kind !== 'project' || n.label.toLowerCase().includes(q) || n.domain.toLowerCase().includes(q)).map((n) => n.id),
    );
    return {
      ...data,
      nodes: data.nodes.filter((n) => keep.has(n.id)),
      edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }, [data, query]);

  const projectCount = data.nodes.filter((n) => n.kind === 'project').length;

  if (projectCount === 0) {
    return (
      <div className="panel p-6 text-center">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {data.emptyReason ?? 'There is nothing to show here yet.'}
        </p>
        <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          The universe draws your real projects and the relationships between them. It stays empty until there are some.
        </p>
        <Link href="/projects" className="btn btn-primary mt-4">Add a project</Link>
        <Link href="/integrations" className="btn mt-4 ml-2">Connect a source</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border" style={{ borderColor: 'var(--line-strong)' }}>
          {(['3d', '2d'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                background: mode === m ? 'var(--accent-dim)' : 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-secondary)',
              }}
              aria-pressed={mode === m}
              onClick={() => { setMode(m); window.localStorage.setItem('ai-brain-universe-mode', m); }}
            >
              {m === '3d' ? 'Spatial' : 'List'}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input max-w-xs"
          placeholder="Filter projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter the universe"
        />
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {filtered.nodes.filter((n) => n.kind === 'project').length} of {projectCount} project(s)
        </span>
      </div>

      {reducedMotion && mode === '3d' && (
        <p className="mb-2 text-xs" style={{ color: 'var(--uncertain)' }}>
          Your system asks for reduced motion, so the spatial view does not auto-rotate. Drag to look around.
        </p>
      )}

      {mode === '3d' && !webglFailed ? (
        <Scene data={filtered} onSelect={setSelected} onFail={() => { setWebglFailed(true); setMode('2d'); }} reducedMotion={reducedMotion} />
      ) : (
        <>
          {webglFailed && (
            <p className="mb-2 text-xs" style={{ color: 'var(--uncertain)' }}>
              WebGL is not available in this browser, so the list view is shown. It contains the same information.
            </p>
          )}
          <FlatView data={filtered} onSelect={setSelected} />
        </>
      )}

      {selected && <Inspector node={selected} edges={data.edges} nodes={data.nodes} onClose={() => setSelected(null)} />}

      <Legend />
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 3D scene                                                         */
/* ---------------------------------------------------------------- */

function Scene({
  data, onSelect, onFail, reducedMotion,
}: {
  data: UniverseData;
  onSelect: (n: UniverseNode | null) => void;
  onFail: () => void;
  reducedMotion: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const container = mount.current;
    if (!container) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    // Imported dynamically so three.js is not in the bundle for pages that
    // never draw a scene.
    void import('three').then((THREE) => {
      if (disposed) return;

      let renderer: import('three').WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' });
      } catch {
        onFail();
        return;
      }

      const width = container.clientWidth;
      const height = Math.max(420, Math.min(680, Math.round(width * 0.58)));
      renderer.setSize(width, height);
      // Capped for integrated GPUs; the scene is lines and spheres, so the
      // extra pixels buy very little.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      container.appendChild(renderer.domElement);
      renderer.domElement.style.borderRadius = '14px';
      renderer.domElement.style.display = 'block';
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.setAttribute(
        'aria-label',
        `Spatial view of ${data.nodes.filter((n) => n.kind === 'project').length} projects. Switch to the list view for an accessible equivalent.`,
      );

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 400);
      camera.position.set(0, 14, 42);

      scene.add(new THREE.AmbientLight(0x5a7184, 1.1));
      const key = new THREE.PointLight(0x61d7e8, 420, 180);
      key.position.set(0, 24, 26);
      scene.add(key);
      const rim = new THREE.PointLight(0xd7b98a, 160, 160);
      rim.position.set(-30, -14, -24);
      scene.add(rim);

      // ---- layout: domains on a ring, projects on an arc within each ----
      const positions = new Map<string, import('three').Vector3>();
      const domains = [...new Set(data.nodes.filter((n) => n.kind === 'domain').map((n) => n.id))];
      positions.set('core', new THREE.Vector3(0, 0, 0));

      domains.forEach((domainId, i) => {
        const angle = (i / Math.max(1, domains.length)) * Math.PI * 2;
        const radius = 15;
        positions.set(domainId, new THREE.Vector3(Math.cos(angle) * radius, (i % 3 - 1) * 3.2, Math.sin(angle) * radius));
      });

      const byDomain = new Map<string, UniverseNode[]>();
      for (const n of data.nodes.filter((x) => x.kind === 'project' || x.kind === 'cluster')) {
        const list = byDomain.get(n.domain) ?? [];
        list.push(n);
        byDomain.set(n.domain, list);
      }
      for (const [domain, members] of byDomain) {
        const anchor = positions.get(`domain:${domain}`) ?? new THREE.Vector3(0, 0, 0);
        const perRing = 9;
        members.forEach((m, i) => {
          const ring = Math.floor(i / perRing);
          const idx = i % perRing;
          const spread = (idx / perRing) * Math.PI * 2;
          const r = 6.5 + ring * 4.5;
          positions.set(m.id, new THREE.Vector3(
            anchor.x + Math.cos(spread) * r,
            anchor.y + Math.sin(spread * 2) * 2.4 + ring * 1.1,
            anchor.z + Math.sin(spread) * r,
          ));
        });
      }

      // ---- the core ----
      const coreGroup = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(3.4, 2),
        new THREE.MeshStandardMaterial({ color: 0x0e141b, emissive: 0x61d7e8, emissiveIntensity: 0.42, metalness: 0.9, roughness: 0.24 }),
      );
      coreGroup.add(core);
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(4.6, 1),
        new THREE.MeshBasicMaterial({ color: 0x61d7e8, wireframe: true, transparent: true, opacity: 0.16 }),
      );
      coreGroup.add(shell);
      scene.add(coreGroup);

      // ---- nodes ----
      const meshes: Array<{ mesh: import('three').Mesh; node: UniverseNode }> = [];
      for (const node of data.nodes) {
        if (node.kind === 'core') continue;
        const pos = positions.get(node.id);
        if (!pos) continue;

        const isDomain = node.kind === 'domain';
        const size = isDomain ? 1.5 : 0.55 + node.weight * 1.5;
        const color = isDomain ? 0x26323d : LIFECYCLE_COLORS[node.lifecycle] ?? 0x9fb0bd;

        const material = node.unconfirmed
          // Hollow: this is a discovery the user has not confirmed is theirs.
          ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.75 })
          : new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: isDomain ? 0.1 : 0.28, metalness: 0.65, roughness: 0.35 });

        const mesh = new THREE.Mesh(
          isDomain ? new THREE.OctahedronGeometry(size, 0) : new THREE.SphereGeometry(size, 20, 16),
          material,
        );
        mesh.position.copy(pos);
        mesh.userData.nodeId = node.id;
        scene.add(mesh);
        meshes.push({ mesh, node });
      }

      // ---- edges: only real relationships ----
      const certainPoints: number[] = [];
      const uncertainPoints: number[] = [];
      for (const edge of data.edges) {
        const a = positions.get(edge.from);
        const b = positions.get(edge.to);
        if (!a || !b) continue;
        const target = edge.certain ? certainPoints : uncertainPoints;
        target.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const addLines = (pts: number[], opacity: number, color: number): void => {
        if (pts.length === 0) return;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
      };
      addLines(certainPoints, 0.3, 0x61d7e8);
      // Fainter and warmer: an inferred link, not an observed one.
      addLines(uncertainPoints, 0.13, 0xd7b98a);

      // ---- interaction: orbit, zoom, pick ----
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let spherical = { radius: 46, theta: 0, phi: 1.1 };
      let dragging = false;
      let last = { x: 0, y: 0 };
      let moved = 0;

      const applyCamera = (): void => {
        camera.position.set(
          spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
          spherical.radius * Math.cos(spherical.phi),
          spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta),
        );
        camera.lookAt(0, 0, 0);
      };
      applyCamera();

      const onPointerDown = (e: PointerEvent): void => {
        dragging = true;
        moved = 0;
        last = { x: e.clientX, y: e.clientY };
        renderer.domElement.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e: PointerEvent): void => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        if (dragging) {
          const dx = e.clientX - last.x;
          const dy = e.clientY - last.y;
          moved += Math.abs(dx) + Math.abs(dy);
          spherical.theta -= dx * 0.005;
          spherical.phi = Math.max(0.25, Math.min(Math.PI - 0.25, spherical.phi - dy * 0.005));
          last = { x: e.clientX, y: e.clientY };
          applyCamera();
          setHover(null);
          return;
        }

        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(meshes.map((m) => m.mesh))[0];
        if (hit) {
          const found = meshes.find((m) => m.mesh === hit.object);
          if (found) {
            renderer.domElement.style.cursor = 'pointer';
            setHover({ label: found.node.label, x: e.clientX - rect.left, y: e.clientY - rect.top });
            return;
          }
        }
        renderer.domElement.style.cursor = 'grab';
        setHover(null);
      };
      const onPointerUp = (e: PointerEvent): void => {
        dragging = false;
        renderer.domElement.releasePointerCapture?.(e.pointerId);
        // A drag is not a click.
        if (moved > 6) return;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(meshes.map((m) => m.mesh))[0];
        const found = hit ? meshes.find((m) => m.mesh === hit.object) : undefined;
        onSelect(found?.node ?? null);
      };
      const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        spherical.radius = Math.max(12, Math.min(140, spherical.radius + e.deltaY * 0.05));
        applyCamera();
      };
      const onKeyDown = (e: KeyboardEvent): void => {
        const step = 0.12;
        if (e.key === 'ArrowLeft') spherical.theta -= step;
        else if (e.key === 'ArrowRight') spherical.theta += step;
        else if (e.key === 'ArrowUp') spherical.phi = Math.max(0.25, spherical.phi - step);
        else if (e.key === 'ArrowDown') spherical.phi = Math.min(Math.PI - 0.25, spherical.phi + step);
        else if (e.key === '+' || e.key === '=') spherical.radius = Math.max(12, spherical.radius - 4);
        else if (e.key === '-') spherical.radius = Math.min(140, spherical.radius + 4);
        else return;
        e.preventDefault();
        applyCamera();
      };

      const el = renderer.domElement;
      el.style.cursor = 'grab';
      el.tabIndex = 0;
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('wheel', onWheel, { passive: false });
      el.addEventListener('keydown', onKeyDown);

      const onResize = (): void => {
        const w = container.clientWidth;
        const h = Math.max(420, Math.min(680, Math.round(w * 0.58)));
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      window.addEventListener('resize', onResize);

      // ---- render loop ----
      let raf = 0;
      let running = true;
      const clock = new THREE.Clock();
      const tick = (): void => {
        if (!running) return;
        raf = requestAnimationFrame(tick);
        const t = clock.getElapsedTime();
        coreGroup.rotation.y = t * 0.12;
        shell.rotation.x = t * 0.07;
        // Idle auto-rotation is a motion effect, so reduced-motion skips it.
        if (!reducedMotion && !dragging) {
          spherical.theta += 0.0007;
          applyCamera();
        }
        renderer.render(scene, camera);
      };
      tick();

      // Pause when scrolled out of view: a spinning scene in a background tab
      // is pure battery drain.
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting && !running) { running = true; tick(); }
        else if (!entry.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
      }, { threshold: 0.05 });
      observer.observe(container);

      cleanup = (): void => {
        running = false;
        cancelAnimationFrame(raf);
        observer.disconnect();
        window.removeEventListener('resize', onResize);
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp);
        el.removeEventListener('wheel', onWheel);
        el.removeEventListener('keydown', onKeyDown);
        scene.traverse((obj) => {
          const mesh = obj as import('three').Mesh;
          mesh.geometry?.dispose?.();
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose?.();
        });
        renderer.dispose();
        el.remove();
      };
    }).catch(() => onFail());

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [data, onSelect, onFail, reducedMotion]);

  return (
    <div className="relative">
      <div ref={mount} className="panel overflow-hidden" style={{ minHeight: 420 }} />
      {hover && (
        <div
          className="glass pointer-events-none absolute rounded-md px-2 py-1 text-xs"
          style={{ left: hover.x + 12, top: hover.y + 12, color: 'var(--text-primary)' }}
        >
          {hover.label}
        </div>
      )}
      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
        Drag to orbit, scroll to zoom, click a node to inspect. Arrow keys work too.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 2D equivalent                                                    */
/* ---------------------------------------------------------------- */

function FlatView({ data, onSelect }: { data: UniverseData; onSelect: (n: UniverseNode) => void }) {
  const domains = [...new Set(data.nodes.filter((n) => n.kind === 'project').map((n) => n.domain))].sort();
  return (
    <div className="panel p-4">
      {domains.map((domain) => {
        const members = data.nodes.filter((n) => n.kind === 'project' && n.domain === domain);
        return (
          <div key={domain} className="mb-5 last:mb-0">
            <h3 className="eyebrow mb-2">{domain} · {members.length}</h3>
            <ul className="space-y-0.5">
              {members.map((node) => {
                const related = data.edges.filter(
                  (e) => (e.from === node.id || e.to === node.id) && e.kind !== 'contains',
                );
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      className="row-link w-full text-left"
                      onClick={() => onSelect(node)}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{
                            background: node.unconfirmed ? 'transparent' : `#${(LIFECYCLE_COLORS[node.lifecycle] ?? 0x9fb0bd).toString(16).padStart(6, '0')}`,
                            border: node.unconfirmed ? '1px solid var(--uncertain)' : 'none',
                          }}
                        />
                        <span className="truncate text-sm">{node.label}</span>
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{node.lifecycle}</span>
                        {node.unconfirmed && <span className="chip chip-uncertain">unconfirmed</span>}
                        {related.length > 0 && <span className="chip">{related.length} link{related.length > 1 ? 's' : ''}</span>}
                      </span>
                      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                        {node.detail.join(' · ')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Inspector({
  node, edges, nodes, onClose,
}: {
  node: UniverseNode;
  edges: UniverseEdge[];
  nodes: UniverseNode[];
  onClose: () => void;
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = edges
    .filter((e) => (e.from === node.id || e.to === node.id) && e.kind !== 'contains')
    .map((e) => ({ kind: e.kind, certain: e.certain, other: byId.get(e.from === node.id ? e.to : e.from) }))
    .filter((l): l is { kind: string; certain: boolean; other: UniverseNode } => l.other !== undefined);

  return (
    <div className="panel-lit mt-3 p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium">{node.label}</h3>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {node.domain} · {node.lifecycle}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close inspector">×</button>
      </header>

      {node.unconfirmed && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--uncertain)', background: 'var(--uncertain-dim)', color: 'var(--uncertain)' }}>
          This project was discovered automatically and you have not confirmed it is yours.
        </p>
      )}

      <dl className="space-y-1.5 text-sm">
        {node.detail.map((d, i) => (
          <dd key={i} style={{ color: 'var(--text-secondary)' }}>{d}</dd>
        ))}
      </dl>

      {links.length > 0 && (
        <div className="mt-3">
          <h4 className="eyebrow mb-1.5">Relationships</h4>
          <ul className="space-y-1 text-xs">
            {links.map((l, i) => (
              <li key={i} style={{ color: 'var(--text-secondary)' }}>
                <span className="mono">{l.kind.replace(/-/g, ' ')}</span> → {l.other.label}
                {!l.certain && <span className="chip chip-uncertain ml-1.5">inferred</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.href && <Link href={node.href} className="btn btn-primary mt-4">Open passport →</Link>}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
      <span>Size = recorded activity</span>
      <span>Distance from core = domain</span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: '#61d7e8' }} /> active
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: '#55d5aa' }} /> shipped
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: '#e8737d' }} /> blocked
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: '#d7b98a' }} /> paused
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2 rounded-full border" style={{ borderColor: '#d7b98a' }} /> unconfirmed
      </span>
      <span>Faint warm lines are inferred, not observed.</span>
    </div>
  );
}
