'use server';

/**
 * Server Actions.
 *
 * Every mutation in the app goes through one of these. They run on the server,
 * resolve the workspace from the session, validate with the core validators,
 * and return a typed result the forms render — so the UI works without
 * client-side JavaScript and there is no second validation layer to drift.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  getAuth, getStore, requireWriteContext, requireContextOrThrow, engines,
  appSecret, clientIp, SESSION_COOKIE, AuthError,
} from './server.ts';
import {
  str, enumOf, strArray, int, bool, isoDate, email as emailOf, ValidationError,
} from '@ai-brain/core';
import {
  generateBrain, fromConfigFile, ConfigImportError, layoutFor, ALL_MODULES,
  parseMarkdown, parseConversationExport, type OnboardingAnswers,
} from '@ai-brain/core/engines';
import { adapterFor, CONNECTORS } from '@ai-brain/core/connectors';
import { encryptSecret } from '@ai-brain/core/security';
import { isTooBroad } from '@ai-brain/core/connectors';
import type {
  BrainProfileKey, Cadence, KnowledgeClass, Lifecycle, ModuleKey,
  ProjectCategory, ResourceKind, TokenScope,
} from '@ai-brain/core/domain';

export interface ActionResult {
  ok: boolean;
  message?: string;
  /** Field-specific error, for inline display. */
  field?: string;
  /** Freeform payload, e.g. a token shown once. */
  data?: Record<string, unknown>;
}

/** Turns thrown errors into a result the form can render. */
async function run(fn: () => Promise<ActionResult> | ActionResult): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, message: err.message, field: err.field };
    if (err instanceof ConfigImportError) return { ok: false, message: err.message };
    if (err instanceof AuthError) return { ok: false, message: err.message };
    // A redirect from inside an action is a thrown control-flow signal.
    if (err && typeof err === 'object' && 'digest' in err && String((err as { digest: unknown }).digest).startsWith('NEXT_REDIRECT')) throw err;
    return { ok: false, message: err instanceof Error ? err.message : 'something went wrong' };
  }
}

function body(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string') continue;
    if (k.endsWith('[]')) {
      const key = k.slice(0, -2);
      (out[key] as string[] | undefined) ??= [];
      (out[key] as string[]).push(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Auth and setup                                                   */
/* ---------------------------------------------------------------- */

export async function setupAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const auth = getAuth();
    if (!auth.needsSetup()) return { ok: false, message: 'this installation already has an account' };

    const answers: OnboardingAnswers = {};
    const profile = b.profile ? enumOf(b, 'profile', ['founder', 'developer', 'creator', 'freelancer', 'research', 'personal', 'student', 'custom'] as const) : undefined;
    if (profile) answers.profile = profile;
    if (b.intents) answers.intents = String(b.intents).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);

    const { token } = auth.register({
      email: emailOf(b, 'email'),
      displayName: str(b, 'displayName', { max: 120 }),
      password: str(b, 'password', { min: 10, max: 400 }),
      isMinorAccount: bool(b, 'isMinorAccount'),
      workspaceName: str(b, 'workspaceName', { optional: true, max: 120 }),
      onboarding: answers,
    });

    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect('/onboarding');
  });
}

export async function loginAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const { token } = getAuth().login(emailOf(b, 'email'), str(b, 'password', { max: 400 }), await clientIp());
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect('/dashboard');
  });
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) getAuth().logout(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

export async function changePasswordAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireContextOrThrow();
    ctx.auth.changePassword(ctx.user.id, str(b, 'current', { max: 400 }), str(b, 'next', { min: 10, max: 400 }));
    (await cookies()).delete(SESSION_COOKIE);
    redirect('/login?changed=1');
  });
}

/* ---------------------------------------------------------------- */
/* Onboarding and configuration                                     */
/* ---------------------------------------------------------------- */

export async function saveBrainAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();

    const answers: OnboardingAnswers = {
      displayName: str(b, 'displayName', { optional: true, max: 120 }),
      profile: enumOf(b, 'profile', ['founder', 'developer', 'creator', 'freelancer', 'research', 'personal', 'student', 'custom'] as const, 'personal'),
      intents: String(b.intents ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20),
      focusAreas: strArray(b, 'focusAreas'),
      primaryGoals: String(b.primaryGoals ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20),
      currentProjects: String(b.currentProjects ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50),
      preferredApps: strArray(b, 'preferredApps'),
      workingStyle: enumOf(b, 'workingStyle', ['deep-work', 'balanced', 'reactive'] as const, 'balanced'),
      automationLevel: enumOf(b, 'automationLevel', ['manual', 'review', 'automatic'] as const, 'review'),
      reportingCadence: enumOf(b, 'reportingCadence', ['daily', 'weekly', 'monthly', 'quarterly', 'manual'] as const, 'weekly'),
      modules: strArray<ModuleKey>(b, 'modules', ALL_MODULES),
      isMinorAccount: ctx.user.isMinorAccount,
      privacy: {
        allowRemoteAi: bool(b, 'allowRemoteAi'),
        allowFileContentImport: bool(b, 'allowFileContentImport', true),
        excludedCategories: String(b.excludedCategories ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        excludedPaths: String(b.excludedPaths ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        sourceRetentionDays: int(b, 'sourceRetentionDays', { default: 0, min: 0, max: 3650 }),
      },
    };
    if (b.assistantInstructions) answers.assistantInstructions = str(b, 'assistantInstructions', { max: 4000 });

    const generated = generateBrain(ctx.workspace.id, answers);
    const saved = ctx.store.brainConfig.save(generated.config);

    ctx.store.transaction(() => {
      // Modules not in the new configuration are switched off, not deleted;
      // their records stay and reappear if the module is re-enabled.
      for (const key of ALL_MODULES) {
        ctx.store.modules.setEnabled(ctx.workspace.id, key, saved.modules.includes(key));
      }
      for (const seed of generated.projectSeeds) {
        if (ctx.store.projects.bySlug(ctx.workspace.id, seed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))) continue;
        ctx.store.projects.create({
          workspaceId: ctx.workspace.id, name: seed.name,
          category: seed.category as ProjectCategory, origin: 'manual',
        });
      }
      const existingGoals = new Set(ctx.store.goals.list(ctx.workspace.id).map((g) => g.title));
      for (const seed of generated.goalSeeds) {
        if (existingGoals.has(seed.title)) continue;
        const parent = ctx.store.goals.create({ workspaceId: ctx.workspace.id, title: seed.title, horizon: seed.horizon });
        for (const child of seed.children ?? []) {
          ctx.store.goals.create({ workspaceId: ctx.workspace.id, title: child.title, horizon: child.horizon, parentGoalId: parent.id });
        }
      }
    });

    ctx.store.audit.log({
      workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'brain.configured',
      subject: `brain_configuration:${saved.id}`, detail: { version: saved.version, profile: saved.profile },
    });

    revalidatePath('/', 'layout');
    return { ok: true, message: `Saved as version ${saved.version}.`, data: { rationale: generated.rationale } };
  });
}

export async function setWidgetVisibilityAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const current = ctx.store.brainConfig.current(ctx.workspace.id);
    if (!current) return { ok: false, message: 'no configuration to update' };

    const visible = new Set(strArray(b, 'widgets'));
    const known = new Set(current.dashboardLayout.widgets.map((w) => w.key));
    const base = known.size > 0 ? current.dashboardLayout : layoutFor(current.profile, current.modules);
    const widgets = base.widgets.map((w) => ({ ...w, visible: visible.has(w.key) }));

    ctx.store.brainConfig.save({ ...current, dashboardLayout: { ...base, widgets } });
    revalidatePath('/dashboard');
    return { ok: true, message: 'Dashboard updated.' };
  });
}

export async function reorderWidgetsAction(order: string[]): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const current = ctx.store.brainConfig.current(ctx.workspace.id);
    if (!current) return { ok: false, message: 'no configuration to update' };
    const byKey = new Map(current.dashboardLayout.widgets.map((w) => [w.key, w]));
    const reordered = [
      ...order.map((k) => byKey.get(k)).filter((w): w is NonNullable<typeof w> => w !== undefined),
      ...current.dashboardLayout.widgets.filter((w) => !order.includes(w.key)),
    ];
    ctx.store.brainConfig.save({ ...current, dashboardLayout: { ...current.dashboardLayout, widgets: reordered } });
    revalidatePath('/dashboard');
    return { ok: true, message: 'Layout saved.' };
  });
}

export async function restoreConfigVersionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const version = int(b, 'version', { min: 1 });
    const old = ctx.store.brainConfig.version(ctx.workspace.id, version);
    if (!old) return { ok: false, message: `version ${version} not found` };

    // Restoring writes a new version rather than rolling back, so the history
    // stays append-only and auditable.
    const saved = ctx.store.brainConfig.save({ ...old, createdBy: 'manual' });
    for (const key of ALL_MODULES) ctx.store.modules.setEnabled(ctx.workspace.id, key, saved.modules.includes(key));
    revalidatePath('/', 'layout');
    return { ok: true, message: `Restored version ${version} as version ${saved.version}.` };
  });
}

export async function importConfigAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'choose a brain.config.json file', field: 'file' };
    if (file.size > 2_000_000) return { ok: false, message: 'that file is too large for a configuration', field: 'file' };

    const parsed = fromConfigFile(JSON.parse(await file.text()), ctx.workspace.id);
    const saved = ctx.store.brainConfig.save(parsed);
    for (const key of ALL_MODULES) ctx.store.modules.setEnabled(ctx.workspace.id, key, saved.modules.includes(key));
    revalidatePath('/', 'layout');
    return { ok: true, message: `Imported as version ${saved.version}. Your records were not touched.` };
  });
}

/* ---------------------------------------------------------------- */
/* Projects                                                         */
/* ---------------------------------------------------------------- */

const CATEGORIES = ['software', 'business', 'product', 'content', 'research', 'client', 'personal', 'study', 'other'] as const;
const LIFECYCLES = ['idea', 'planning', 'active', 'blocked', 'paused', 'shipped', 'archived'] as const;

export async function createProjectAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const project = ctx.store.projects.create({
      workspaceId: ctx.workspace.id,
      name: str(b, 'name', { max: 200 }),
      description: str(b, 'description', { optional: true, max: 4000 }),
      category: enumOf<ProjectCategory>(b, 'category', CATEGORIES, 'other'),
      lifecycle: enumOf<Lifecycle>(b, 'lifecycle', LIFECYCLES, 'active'),
      tags: String(b.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      origin: 'manual',
    });
    revalidatePath('/projects');
    revalidatePath('/dashboard');
    return { ok: true, message: `Created "${project.name}".`, data: { slug: project.slug } };
  });
}

export async function updateProjectAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const id = str(b, 'id');
    const updated = ctx.store.projects.update(ctx.workspace.id, id, {
      name: str(b, 'name', { max: 200 }),
      description: str(b, 'description', { optional: true, max: 4000 }),
      category: enumOf<ProjectCategory>(b, 'category', CATEGORIES, 'other'),
      lifecycle: enumOf<Lifecycle>(b, 'lifecycle', LIFECYCLES, 'active'),
      tags: String(b.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    if (!updated) return { ok: false, message: 'project not found' };
    revalidatePath(`/projects/${updated.slug}`);
    revalidatePath('/projects');
    return { ok: true, message: 'Saved.' };
  });
}

export async function reviewProjectAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const { discovery } = engines(ctx.store);
    const id = str(b, 'id');
    const decision = enumOf(b, 'decision', ['confirm', 'reject', 'merge'] as const);

    if (decision === 'merge') {
      const target = str(b, 'targetId');
      const result = discovery.merge(ctx.workspace.id, id, target);
      if (!result) return { ok: false, message: 'could not merge those projects' };
      revalidatePath('/projects');
      return { ok: true, message: `Merged, moving ${result.moved} record(s).` };
    }

    const project = decision === 'confirm'
      ? discovery.confirm(ctx.workspace.id, id)
      : discovery.reject(ctx.workspace.id, id);
    if (!project) return { ok: false, message: 'project not found' };

    ctx.store.audit.log({
      workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: `project.${decision}ed`,
      subject: `project:${id}`, detail: { name: project.name },
    });
    revalidatePath('/projects/review');
    revalidatePath('/dashboard');
    return { ok: true, message: decision === 'confirm' ? `Confirmed "${project.name}".` : `Rejected "${project.name}". Future syncs will skip it.` };
  });
}

export async function deleteProjectAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const id = str(b, 'id');
    if (str(b, 'confirm', { optional: true }) !== 'delete') {
      return { ok: false, message: 'type delete to confirm', field: 'confirm' };
    }
    ctx.store.projects.delete(ctx.workspace.id, id);
    revalidatePath('/projects');
    redirect('/projects');
  });
}

/* ---------------------------------------------------------------- */
/* Knowledge, tasks, goals, decisions                               */
/* ---------------------------------------------------------------- */

export async function createKnowledgeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const record = ctx.store.knowledge.create({
      workspaceId: ctx.workspace.id,
      projectId: str(b, 'projectId', { optional: true }) || null,
      title: str(b, 'title', { max: 300 }),
      body: str(b, 'body', { optional: true, max: 200_000 }),
      klass: enumOf<KnowledgeClass>(b, 'klass', ['fact', 'decision', 'idea', 'action', 'insight'] as const, 'fact'),
      tags: String(b.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      origin: 'manual',
      confidence: 'observed',
      observedAt: isoDate(b, 'observedAt') ?? undefined,
    });
    revalidatePath('/knowledge');
    return { ok: true, message: 'Saved.', data: { id: record.id } };
  });
}

export async function updateKnowledgeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const updated = ctx.store.knowledge.update(ctx.workspace.id, str(b, 'id'), {
      title: str(b, 'title', { max: 300 }),
      body: str(b, 'body', { optional: true, max: 200_000 }),
      klass: enumOf<KnowledgeClass>(b, 'klass', ['fact', 'decision', 'idea', 'action', 'insight'] as const, 'fact'),
      tags: String(b.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      projectId: str(b, 'projectId', { optional: true }) || null,
    });
    if (!updated) return { ok: false, message: 'record not found' };
    revalidatePath(`/knowledge/${updated.id}`);
    return { ok: true, message: 'Saved.' };
  });
}

export async function resolveContradictionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const { knowledge } = engines(ctx.store);
    const keepId = str(b, 'keepId');
    const action = enumOf(b, 'action', ['supersede', 'keep-both'] as const);

    if (action === 'keep-both') {
      ctx.store.knowledge.update(ctx.workspace.id, keepId, { contradictsId: null });
      revalidatePath('/knowledge');
      return { ok: true, message: 'Both records kept; the conflict flag is cleared.' };
    }
    knowledge.supersede(ctx.workspace.id, str(b, 'oldId'), keepId);
    revalidatePath('/knowledge');
    return { ok: true, message: 'The older record is archived and still readable.' };
  });
}

export async function deleteKnowledgeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    ctx.store.knowledge.delete(ctx.workspace.id, str(b, 'id'));
    revalidatePath('/knowledge');
    redirect('/knowledge');
  });
}

export async function importNotesAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const { knowledge } = engines(ctx.store);
    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    const pasted = String(form.get('pasted') ?? '').trim();
    if (files.length === 0 && pasted === '') return { ok: false, message: 'choose files or paste some text', field: 'files' };

    const docs = [];
    let totalBytes = 0;
    for (const file of files) {
      totalBytes += file.size;
      if (totalBytes > 32_000_000) return { ok: false, message: 'that is more than 32 MB in one import; try fewer files', field: 'files' };
      const text = await file.text();
      if (file.name.endsWith('.json')) {
        const conversations = parseConversationExport(text);
        if (conversations.length === 0) {
          return { ok: false, message: `${file.name} is not a recognised conversation export`, field: 'files' };
        }
        docs.push(...conversations);
      } else {
        const parsed = parseMarkdown(file.name, text);
        docs.push({ title: parsed.title, body: parsed.body, locator: file.name, tags: parsed.tags, origin: 'import' as const });
      }
    }
    if (pasted !== '') {
      const parsed = parseMarkdown('pasted-note.md', pasted);
      docs.push({ title: parsed.title, body: parsed.body, locator: 'pasted', tags: parsed.tags, origin: 'manual' as const });
    }

    const result = knowledge.ingestBatch(
      ctx.workspace.id,
      files.some((f) => f.name.endsWith('.json')) ? 'conversation-export' : 'markdown',
      files.length > 0 ? `${files.length} file(s)` : 'pasted text',
      docs,
      {
        allowFileContentImport: ctx.config?.privacy.allowFileContentImport ?? true,
        excludedCategories: ctx.config?.privacy.excludedCategories ?? [],
      },
    );

    revalidatePath('/knowledge');
    const parts = [`Imported ${result.created} record(s).`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped as duplicates or excluded.`);
    if (result.redactions > 0) parts.push(`${result.redactions} secret-shaped value(s) were redacted before storing.`);
    if (result.contradictions > 0) parts.push(`${result.contradictions} record(s) conflict with something you already had.`);
    return { ok: true, message: parts.join(' ') };
  });
}

export async function createTaskAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    ctx.store.tasks.create({
      workspaceId: ctx.workspace.id,
      title: str(b, 'title', { max: 300 }),
      notes: str(b, 'notes', { optional: true, max: 8000 }),
      projectId: str(b, 'projectId', { optional: true }) || null,
      goalId: str(b, 'goalId', { optional: true }) || null,
      priority: int(b, 'priority', { default: 3, min: 1, max: 4 }) as 1 | 2 | 3 | 4,
      dueAt: isoDate(b, 'dueAt'),
      estimateMinutes: b.estimateMinutes ? int(b, 'estimateMinutes', { min: 0, max: 100_000 }) : null,
    });
    revalidatePath('/tasks');
    revalidatePath('/dashboard');
    return { ok: true, message: 'Added.' };
  });
}

export async function updateTaskAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const patch: Record<string, unknown> = {};
    if (b.status) patch.status = enumOf(b, 'status', ['todo', 'doing', 'done', 'blocked', 'dropped'] as const);
    if (b.title) patch.title = str(b, 'title', { max: 300 });
    if (b.priority) patch.priority = int(b, 'priority', { min: 1, max: 4 });
    if (b.dueAt !== undefined) patch.dueAt = isoDate(b, 'dueAt');
    const updated = ctx.store.tasks.update(ctx.workspace.id, str(b, 'id'), patch);
    if (!updated) return { ok: false, message: 'task not found' };
    revalidatePath('/tasks');
    revalidatePath('/dashboard');
    return { ok: true, message: 'Updated.' };
  });
}

export async function deleteTaskAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    ctx.store.tasks.delete(ctx.workspace.id, str(body(form), 'id'));
    revalidatePath('/tasks');
    return { ok: true, message: 'Deleted.' };
  });
}

export async function createGoalAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    ctx.store.goals.create({
      workspaceId: ctx.workspace.id,
      title: str(b, 'title', { max: 300 }),
      description: str(b, 'description', { optional: true, max: 4000 }),
      horizon: enumOf(b, 'horizon', ['quarter', 'year', 'long-term'] as const, 'quarter'),
      projectId: str(b, 'projectId', { optional: true }) || null,
      parentGoalId: str(b, 'parentGoalId', { optional: true }) || null,
      targetDate: isoDate(b, 'targetDate'),
      progress: int(b, 'progress', { default: 0, min: 0, max: 100 }),
      progressOrigin: 'manual',
    });
    revalidatePath('/goals');
    return { ok: true, message: 'Goal added.' };
  });
}

export async function updateGoalAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const patch: Record<string, unknown> = { progressOrigin: 'manual' };
    if (b.title) patch.title = str(b, 'title', { max: 300 });
    if (b.progress !== undefined) patch.progress = int(b, 'progress', { min: 0, max: 100 });
    if (b.status) patch.status = enumOf(b, 'status', ['active', 'achieved', 'dropped', 'at-risk'] as const);
    const updated = ctx.store.goals.update(ctx.workspace.id, str(b, 'id'), patch);
    if (!updated) return { ok: false, message: 'goal not found' };
    revalidatePath('/goals');
    return { ok: true, message: 'Updated.' };
  });
}

export async function deleteGoalAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    ctx.store.goals.delete(ctx.workspace.id, str(body(form), 'id'));
    revalidatePath('/goals');
    return { ok: true, message: 'Deleted.' };
  });
}

export async function createDecisionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const supersedes = str(b, 'supersedesId', { optional: true });
    ctx.store.decisions.create({
      workspaceId: ctx.workspace.id,
      title: str(b, 'title', { max: 300 }),
      context: str(b, 'context', { optional: true, max: 8000 }),
      choice: str(b, 'choice', { optional: true, max: 2000 }),
      rationale: str(b, 'rationale', { optional: true, max: 8000 }),
      alternatives: String(b.alternatives ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
      outcome: str(b, 'outcome', { optional: true, max: 4000 }),
      status: enumOf(b, 'status', ['proposed', 'accepted', 'superseded', 'reversed'] as const, 'accepted'),
      projectId: str(b, 'projectId', { optional: true }) || null,
      supersedesId: supersedes || null,
      decidedAt: isoDate(b, 'decidedAt') ?? undefined,
    });
    revalidatePath('/decisions');
    return { ok: true, message: 'Decision recorded.' };
  });
}

export async function updateDecisionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const updated = ctx.store.decisions.update(ctx.workspace.id, str(b, 'id'), {
      outcome: str(b, 'outcome', { optional: true, max: 4000 }),
      status: enumOf(b, 'status', ['proposed', 'accepted', 'superseded', 'reversed'] as const, 'accepted'),
    });
    if (!updated) return { ok: false, message: 'decision not found' };
    revalidatePath('/decisions');
    return { ok: true, message: 'Updated.' };
  });
}

/* ---------------------------------------------------------------- */
/* Resources and time                                               */
/* ---------------------------------------------------------------- */

const RESOURCE_KINDS = ['time', 'subscription', 'infrastructure', 'tool', 'person', 'budget', 'ai-api'] as const;

export async function createResourceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    // Entered in major units; stored in minor to avoid float drift.
    const amount = b.amount !== undefined && b.amount !== '' ? Math.round(Number(b.amount) * 100) : null;
    if (amount !== null && !Number.isFinite(amount)) return { ok: false, message: 'amount must be a number', field: 'amount' };

    ctx.store.resources.create({
      workspaceId: ctx.workspace.id,
      kind: enumOf<ResourceKind>(b, 'kind', RESOURCE_KINDS, 'subscription'),
      name: str(b, 'name', { max: 200 }),
      amountMinor: amount,
      currency: str(b, 'currency', { default: 'USD', max: 3 }).toUpperCase(),
      period: b.period ? enumOf(b, 'period', ['one-off', 'monthly', 'yearly'] as const) : null,
      projectId: str(b, 'projectId', { optional: true }) || null,
      notes: str(b, 'notes', { optional: true, max: 2000 }),
      lastConfirmedAt: bool(b, 'confirmNow') ? new Date().toISOString() : null,
      origin: 'manual',
    });
    revalidatePath('/resources');
    return { ok: true, message: 'Recorded.' };
  });
}

export async function confirmResourceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const updated = ctx.store.resources.update(ctx.workspace.id, str(body(form), 'id'), {
      lastConfirmedAt: new Date().toISOString(),
    });
    if (!updated) return { ok: false, message: 'resource not found' };
    revalidatePath('/resources');
    return { ok: true, message: `Confirmed "${updated.name}" is still in use.` };
  });
}

export async function endResourceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const updated = ctx.store.resources.update(ctx.workspace.id, str(body(form), 'id'), {
      endedAt: new Date().toISOString(),
    });
    if (!updated) return { ok: false, message: 'resource not found' };
    revalidatePath('/resources');
    return {
      ok: true,
      message: `Marked "${updated.name}" as ended here. AI BRAIN cannot cancel it with the provider — you have to do that yourself.`,
    };
  });
}

export async function deleteResourceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    ctx.store.resources.delete(ctx.workspace.id, str(body(form), 'id'));
    revalidatePath('/resources');
    return { ok: true, message: 'Deleted.' };
  });
}

export async function logTimeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    ctx.store.time.log({
      workspaceId: ctx.workspace.id,
      minutes: int(b, 'minutes', { min: 1, max: 24 * 60 }),
      label: str(b, 'label', { optional: true, max: 200 }),
      kind: enumOf(b, 'kind', ['focus', 'meeting', 'admin', 'break'] as const, 'focus'),
      projectId: str(b, 'projectId', { optional: true }) || null,
      occurredOn: str(b, 'occurredOn', { optional: true }) || new Date().toISOString().slice(0, 10),
      origin: 'manual',
    });
    revalidatePath('/resources');
    revalidatePath('/dashboard');
    return { ok: true, message: 'Time logged.' };
  });
}

export async function recordMetricAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const value = Number(b.value);
    if (!Number.isFinite(value)) return { ok: false, message: 'value must be a number', field: 'value' };
    ctx.store.metrics.record({
      workspaceId: ctx.workspace.id,
      projectId: str(b, 'projectId', { optional: true }) || null,
      key: str(b, 'key', { max: 60 }).toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
      label: str(b, 'label', { max: 120 }),
      value,
      unit: str(b, 'unit', { optional: true, max: 20 }),
      target: b.target !== undefined && b.target !== '' ? Number(b.target) : null,
      origin: 'manual',
      sourceId: null,
      observedAt: isoDate(b, 'observedAt') ?? new Date().toISOString(),
    });
    revalidatePath('/resources');
    return { ok: true, message: 'Metric recorded.' };
  });
}

/* ---------------------------------------------------------------- */
/* Connections and sync                                             */
/* ---------------------------------------------------------------- */

export async function connectGitHubAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const secret = appSecret();
    if (!secret) return { ok: false, message: 'set APP_SECRET in your .env before storing a credential' };

    const token = str(b, 'token', { max: 400 });
    const allowlist = String(b.allowlist ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

    const adapter = adapterFor('github')!;
    const verified = await adapter.verify({
      connector: 'github', accountLabel: '', credential: token, allowlist, cursor: null,
      privacy: { excludedPaths: [], excludedCategories: [], allowFileContentImport: true },
    });
    if (!verified.ok) return { ok: false, message: verified.error ?? 'GitHub rejected that token', field: 'token' };

    const account = ctx.store.accounts.create({
      workspaceId: ctx.workspace.id, connector: 'github',
      accountLabel: verified.accountLabel,
      credentialCipher: encryptSecret(token, secret),
      scopes: verified.scopes, allowlist,
    });
    ctx.store.audit.log({
      workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'connector.connected',
      subject: `connected_account:${account.id}`,
      detail: { connector: 'github', account: verified.accountLabel, allowlistSize: allowlist.length },
    });
    revalidatePath('/integrations');
    return {
      ok: true,
      message: allowlist.length === 0
        ? `Connected as ${verified.accountLabel}. With no allowlist, every repository this token can see is in scope.`
        : `Connected as ${verified.accountLabel}, scoped to ${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'}.`,
    };
  });
}

export async function connectLocalDirectoryAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const dirs = String(b.directories ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (dirs.length === 0) return { ok: false, message: 'list at least one directory', field: 'directories' };

    const tooBroad = dirs.filter((d) => isTooBroad(d));
    if (tooBroad.length > 0) {
      return {
        ok: false,
        field: 'directories',
        message: `${tooBroad.join(', ')} would authorize an entire home directory. Point at the folder your projects live in instead.`,
      };
    }

    const adapter = adapterFor('local-directory')!;
    const verified = await adapter.verify({
      connector: 'local-directory', accountLabel: '', credential: null, allowlist: dirs, cursor: null,
      privacy: { excludedPaths: [], excludedCategories: [], allowFileContentImport: true },
    });
    if (!verified.ok) return { ok: false, message: verified.error ?? 'those directories cannot be read', field: 'directories' };

    const account = ctx.store.accounts.create({
      workspaceId: ctx.workspace.id, connector: 'local-directory',
      accountLabel: verified.accountLabel, credentialCipher: null,
      scopes: ['read'], allowlist: dirs,
    });
    ctx.store.audit.log({
      workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'connector.connected',
      subject: `connected_account:${account.id}`, detail: { connector: 'local-directory', directories: dirs },
    });
    revalidatePath('/integrations');
    return { ok: true, message: `Authorized ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}.` };
  });
}

export async function connectAgentAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const connector = enumOf(b, 'connector', ['claude-code', 'codex'] as const);
    const existing = ctx.store.accounts.byConnector(ctx.workspace.id, connector);
    if (existing.length > 0) return { ok: false, message: `${CONNECTORS[connector].label} is already set up.` };

    ctx.store.accounts.create({
      workspaceId: ctx.workspace.id, connector,
      accountLabel: 'local', credentialCipher: null, scopes: ['events:write'], allowlist: [],
    });
    revalidatePath('/integrations');
    return {
      ok: true,
      message: `${CONNECTORS[connector].label} is ready to receive events. Issue a token and install the snippet below yourself — AI BRAIN never edits your settings files.`,
    };
  });
}

export async function syncAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const { sync } = engines(ctx.store);
    const id = str(b, 'accountId');
    const secret = appSecret();

    try {
      const result = await sync.run(ctx.workspace.id, id, {
        trigger: 'manual',
        ...(secret ? { appSecret: secret } : {}),
      });
      revalidatePath('/integrations');
      revalidatePath('/dashboard');
      revalidatePath('/projects');
      const s = result.stats;
      const parts = [
        `${s.sourcesSeen} source record(s) seen, ${s.sourcesWritten} written.`,
        `${s.projectsCreated} project(s) created, ${s.projectsUpdated} updated.`,
      ];
      if (s.projectsQueuedForReview > 0) parts.push(`${s.projectsQueuedForReview} waiting for your review.`);
      if (s.skippedByPrivacy > 0) parts.push(`${s.skippedByPrivacy} item(s) skipped by your privacy settings.`);
      if (s.rateLimitWaits > 0) parts.push(`Waited ${s.rateLimitWaits} time(s) on rate limits.`);
      if (result.hasMore) parts.push('There is more to fetch; run it again to continue.');
      return {
        ok: true,
        message: parts.join(' '),
        data: { warnings: result.warnings, queued: result.queuedForReview },
      };
    } catch (err) {
      revalidatePath('/integrations');
      return { ok: false, message: err instanceof Error ? err.message : 'sync failed' };
    }
  });
}

export async function revokeConnectionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const id = str(body(form), 'accountId');
    ctx.store.accounts.revoke(ctx.workspace.id, id);
    ctx.store.audit.log({
      workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'connector.revoked',
      subject: `connected_account:${id}`, detail: {},
    });
    revalidatePath('/integrations');
    return { ok: true, message: 'Revoked. The stored credential is destroyed; records already synced are kept until you delete them.' };
  });
}

export async function deleteConnectorDataAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    if (str(b, 'confirm', { optional: true }) !== 'delete') {
      return { ok: false, message: 'type delete to confirm', field: 'confirm' };
    }
    const connector = str(b, 'connector');
    const { deleted } = engines(ctx.store).portability.deleteSourceData(ctx.workspace.id, connector);
    revalidatePath('/integrations');
    revalidatePath('/projects');
    return {
      ok: true,
      message: `Deleted ${deleted.sources} source record(s), ${deleted.knowledge} knowledge record(s) and ${deleted.activity} activity event(s). ${deleted.projectsArchived} project(s) were archived rather than deleted, so your own notes on them survive.`,
    };
  });
}

/* ---------------------------------------------------------------- */
/* Reviews, tokens, account                                         */
/* ---------------------------------------------------------------- */

export async function runReviewAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const cadence = enumOf<Cadence>(b, 'cadence', ['daily', 'weekly', 'monthly', 'quarterly'] as const, ctx.config?.reportingCadence ?? 'weekly');
    const { report } = engines(ctx.store).reviews.runReview(ctx.workspace.id, cadence, ctx.config);
    revalidatePath('/reports');
    return { ok: true, message: 'Review complete.', data: { id: report.id } };
  });
}

export async function issueTokenAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    const scopes = strArray<TokenScope>(b, 'scopes', [
      'brain:read', 'projects:read', 'knowledge:read', 'resources:read', 'activity:read', 'propose:write',
    ] as const);
    if (scopes.length === 0) return { ok: false, message: 'choose at least one scope', field: 'scopes' };

    const days = b.days ? int(b, 'days', { min: 1, max: 3650 }) : undefined;
    const { raw } = ctx.auth.issueToken(ctx.workspace.id, ctx.user.id, str(b, 'label', { max: 120 }), scopes, days);
    revalidatePath('/settings');
    return {
      ok: true,
      message: 'Token created. It is shown once and only its hash is stored.',
      data: { token: raw, scopes },
    };
  });
}

export async function revokeTokenAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    ctx.auth.revokeToken(ctx.workspace.id, str(body(form), 'id'), ctx.user.id);
    revalidatePath('/settings');
    return { ok: true, message: 'Revoked.' };
  });
}

export async function importExportAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireWriteContext();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'choose an export file', field: 'file' };
    if (file.size > 200_000_000) return { ok: false, message: 'that file is larger than 200 MB', field: 'file' };

    const { imported, warnings } = engines(ctx.store).portability.importWorkspace(ctx.workspace.id, JSON.parse(await file.text()));
    revalidatePath('/', 'layout');
    const summary = Object.entries(imported).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
    return {
      ok: true,
      message: `Imported ${summary || 'nothing new'}.${warnings.length ? ` ${warnings.join(' ')}` : ''}`,
    };
  });
}

export async function deleteWorkspaceAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    if (str(b, 'confirm', { optional: true }) !== ctx.workspace.name) {
      return { ok: false, message: `type the workspace name exactly: ${ctx.workspace.name}`, field: 'confirm' };
    }
    engines(ctx.store).portability.deleteWorkspace(ctx.workspace.id, ctx.user.id);
    (await cookies()).delete(SESSION_COOKIE);
    redirect('/');
  });
}

export async function deleteAccountAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const b = body(form);
    const ctx = await requireWriteContext();
    if (str(b, 'confirm', { optional: true }) !== 'delete my account') {
      return { ok: false, message: 'type "delete my account" to confirm', field: 'confirm' };
    }
    engines(ctx.store).portability.deleteAccount(ctx.user.id);
    (await cookies()).delete(SESSION_COOKIE);
    redirect('/');
  });
}

/* ---------------------------------------------------------------- */
/* Assistant                                                        */
/* ---------------------------------------------------------------- */

export interface AskResult extends ActionResult {
  answer?: {
    text: string;
    bullets: string[];
    certainty: string;
    citations: Array<{ label: string; source: string; href?: string }>;
    caveats: string[];
    suggestions: string[];
    narration?: { used: boolean; note?: string; costMinor: number };
  };
}

export async function askAction(_prev: AskResult | null, form: FormData): Promise<AskResult> {
  const result = await run(async () => {
    const b = body(form);
    const ctx = await requireContextOrThrow();
    const question = str(b, 'question', { max: 500 });
    const { assistant } = engines(ctx.store);
    const answer = assistant.ask(ctx.workspace.id, question, ctx.config);

    // A provider, if configured, may only rephrase what was computed. The
    // grounded text is what gets returned if anything goes wrong.
    let narration: { used: boolean; note?: string; costMinor: number } | undefined;
    let text = answer.text;
    if (ctx.config?.privacy.allowRemoteAi || process.env.AI_PROVIDER === 'ollama') {
      const { providerFor } = await import('./server.ts');
      const { provider } = providerFor(ctx.store, ctx.workspace.id, ctx.config);
      const grounded = [answer.text, ...answer.bullets.map((x) => `- ${x}`), ...answer.caveats.map((c) => `Caveat: ${c}`)].join('\n');
      const out = await provider.narrate({
        grounded,
        instructions: 'Rewrite this as two or three plain sentences for a dashboard. Keep every number and every caveat.',
      });
      if (out.usedProvider) text = out.text;
      narration = { used: out.usedProvider, ...(out.note ? { note: out.note } : {}), costMinor: out.estimatedCostMinor };
    }

    return {
      ok: true,
      answer: {
        text,
        bullets: answer.bullets,
        certainty: answer.certainty,
        citations: answer.citations,
        caveats: answer.caveats,
        suggestions: answer.suggestions,
        ...(narration ? { narration } : {}),
      },
    } satisfies AskResult;
  });
  return result as AskResult;
}
