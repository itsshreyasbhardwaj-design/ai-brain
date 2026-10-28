'use client';

/**
 * Dashboard customisation: visibility and order.
 *
 * Drag-and-drop uses the HTML5 drag API with keyboard equivalents (the move
 * buttons), because a reorder that only works with a mouse is not a feature
 * everyone has. Both paths call the same Server Action.
 */

import { useState } from 'react';
import { setWidgetVisibilityAction, reorderWidgetsAction } from '@/lib/actions';
import { ActionForm, SubmitButton, Checkbox } from './ui';

export function DashboardCustomiser({
  allKeys, visibleKeys, catalog,
}: {
  allKeys: string[];
  visibleKeys: string[];
  catalog: Record<string, { label: string; requires: string | null; span: number }>;
}) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState(allKeys);
  const [dragging, setDragging] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (allKeys.length === 0) return null;

  const move = (key: string, delta: number): void => {
    const i = order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    next.splice(i, 1);
    next.splice(j, 0, key);
    setOrder(next);
  };

  const persistOrder = async (next: string[]): Promise<void> => {
    setSaving(true);
    await reorderWidgetsAction(next);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} aria-expanded={open}>
        Customise
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
          style={{ background: 'rgb(5 7 9 / 0.72)' }}
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="panel-lit w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Customise dashboard"
          >
            <header className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-sm font-medium">Customise dashboard</h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Order is saved as you change it. Visibility saves when you apply.
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </header>

            <div className="mb-4">
              <h3 className="eyebrow mb-2">Order</h3>
              <ul className="space-y-1">
                {order.map((key, i) => (
                  <li
                    key={key}
                    draggable
                    onDragStart={() => setDragging(key)}
                    onDragEnd={() => { setDragging(null); void persistOrder(order); }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!dragging || dragging === key) return;
                      const from = order.indexOf(dragging);
                      const to = order.indexOf(key);
                      if (from < 0 || to < 0) return;
                      const next = [...order];
                      next.splice(from, 1);
                      next.splice(to, 0, dragging);
                      setOrder(next);
                    }}
                    className="flex items-center justify-between rounded-lg border px-2.5 py-1.5"
                    style={{
                      borderColor: dragging === key ? 'var(--accent)' : 'var(--line)',
                      background: 'var(--surface-raised)',
                      cursor: 'grab',
                    }}
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <span aria-hidden style={{ color: 'var(--text-ghost)' }}>⣿</span>
                      {catalog[key]?.label ?? key}
                    </span>
                    <span className="flex gap-0.5">
                      <button
                        type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${catalog[key]?.label ?? key} up`}
                        disabled={i === 0}
                        onClick={() => { move(key, -1); void persistOrder(order); }}
                      >↑</button>
                      <button
                        type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${catalog[key]?.label ?? key} down`}
                        disabled={i === order.length - 1}
                        onClick={() => { move(key, 1); void persistOrder(order); }}
                      >↓</button>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px]" aria-live="polite" style={{ color: saved ? 'var(--verified)' : 'var(--text-ghost)' }}>
                {saving ? 'Saving…' : saved ? 'Order saved.' : 'Drag, or use the arrow buttons.'}
              </p>
            </div>

            <div className="border-t pt-4" style={{ borderColor: 'var(--line-subtle)' }}>
              <h3 className="eyebrow mb-2">Visible</h3>
              <ActionForm action={setWidgetVisibilityAction} onDone={() => setOpen(false)}>
                {allKeys.map((key) => (
                  <Checkbox
                    key={key}
                    name="widgets[]"
                    value={key}
                    label={catalog[key]?.label ?? key}
                    defaultChecked={visibleKeys.includes(key)}
                  />
                ))}
                <SubmitButton>Apply</SubmitButton>
              </ActionForm>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
