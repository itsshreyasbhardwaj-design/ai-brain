/**
 * The personal AI BRAIN generator.
 *
 * Deterministic by design: the same onboarding answers always produce the same
 * configuration, with no model call and therefore no API key, no cost and no
 * network. An AI provider can later *refine* the result (see ai/refine.ts), but
 * it can never be required to produce one.
 */

import type {
  BrainConfiguration, BrainProfileKey, Cadence, ConnectorKey, GoalSeed,
  ModuleKey, PrivacyPreferences,
} from '../domain/types.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.ts';
import { ALL_MODULES, PROFILE_TEMPLATES, layoutFor } from './profiles.ts';

/** Everything onboarding can ask. Every field is optional and skippable. */
export interface OnboardingAnswers {
  displayName?: string;
  profile?: BrainProfileKey;
  /** Free-text: what the user wants help with. */
  intents?: string[];
  /** Areas to monitor; maps onto module keys. */
  focusAreas?: string[];
  workingStyle?: BrainConfiguration['workingStyle'];
  primaryGoals?: string[];
  currentProjects?: string[];
  preferredApps?: string[];
  automationLevel?: BrainConfiguration['automationLevel'];
  reportingCadence?: Cadence;
  /** Explicit module overrides for the custom profile. */
  modules?: ModuleKey[];
  privacy?: Partial<PrivacyPreferences>;
  isMinorAccount?: boolean;
  /** Assistant instructions the user wrote themselves. */
  assistantInstructions?: string;
}

/** Maps the words users actually type to the module that serves them. */
const INTENT_MODULE_HINTS: Array<{ re: RegExp; modules: ModuleKey[] }> = [
  { re: /\b(code|coding|repo|repositor|git|deploy|ci|test|software|engineer|dev\b|programming)/i, modules: ['developer', 'projects'] },
  { re: /\b(revenue|sales|customer|client|invoice|business|startup|company|mrr|pricing)/i, modules: ['business', 'resources'] },
  { re: /\b(cost|spend|budget|subscription|money|finance|expense|burn)/i, modules: ['resources'] },
  { re: /\b(time|hours|focus|calendar|schedul|deadline|overcommit|busy)/i, modules: ['calendar', 'resources', 'productivity'] },
  { re: /\b(note|knowledge|second brain|remember|document|research|source|reference)/i, modules: ['knowledge'] },
  { re: /\b(goal|objective|okr|target|ambition)/i, modules: ['goals'] },
  { re: /\b(decision|decide|rationale|adr|choice|trade.?off)/i, modules: ['decisions'] },
  { re: /\b(task|todo|to.do|backlog|priorit)/i, modules: ['tasks'] },
  { re: /\b(habit|routine|wellbeing|balance|health)/i, modules: ['productivity'] },
  { re: /\b(report|review|weekly|digest|summar)/i, modules: ['reports'] },
  { re: /\b(connect|integrat|sync|github|notion|drive|api)/i, modules: ['integrations'] },
  { re: /\b(project|track|portfolio|overview|what am i working on)/i, modules: ['projects'] },
];

/** Maps named apps to the connector that could actually serve them. */
const APP_CONNECTOR_HINTS: Array<{ re: RegExp; connector: ConnectorKey }> = [
  { re: /\bgithub\b/i, connector: 'github' },
  { re: /\b(claude code|claude-code)\b/i, connector: 'claude-code' },
  { re: /\b(codex|openai codex)\b/i, connector: 'codex' },
  { re: /\b(obsidian|markdown|notes?|logseq|bear|notion)\b/i, connector: 'markdown-import' },
  { re: /\b(chatgpt|claude|conversation|transcript)\b/i, connector: 'conversation-import' },
  { re: /\b(local|folder|director|filesystem)\b/i, connector: 'local-directory' },
];

export const DEFAULT_PRIVACY: PrivacyPreferences = {
  excludedCategories: [],
  excludedPaths: [],
  // Off by default: nothing leaves the machine until the user turns it on.
  allowRemoteAi: false,
  allowFileContentImport: true,
  sourceRetentionDays: 0,
};

export interface GeneratedBrain {
  config: Omit<BrainConfiguration, 'id' | 'version' | 'createdAt'>;
  /** Project stubs to create from the answers, if any. */
  projectSeeds: Array<{ name: string; category: string }>;
  goalSeeds: GoalSeed[];
  /** Human-readable explanation of why this configuration looks like it does. */
  rationale: string[];
}

export function generateBrain(workspaceId: string, answers: OnboardingAnswers): GeneratedBrain {
  const rationale: string[] = [];
  const profile: BrainProfileKey = answers.profile ?? inferProfile(answers) ?? 'personal';
  const template = PROFILE_TEMPLATES[profile];
  rationale.push(
    answers.profile
      ? `Started from the ${template.label} template, which you chose.`
      : `No template chosen, so the ${template.label} preset was inferred from your answers.`,
  );

  // Modules: template preset, plus anything the user's own words imply.
  const modules = new Set<ModuleKey>(
    profile === 'custom' && answers.modules?.length ? answers.modules : template.modules,
  );
  const intentText = [...(answers.intents ?? []), ...(answers.focusAreas ?? [])].join(' ');
  const addedByIntent: ModuleKey[] = [];
  for (const hint of INTENT_MODULE_HINTS) {
    if (!hint.re.test(intentText)) continue;
    for (const m of hint.modules) {
      if (!modules.has(m)) { modules.add(m); addedByIntent.push(m); }
    }
  }
  // Focus areas may also name a module directly.
  for (const area of answers.focusAreas ?? []) {
    const key = area.trim().toLowerCase().replace(/\s+/g, '-') as ModuleKey;
    if ((ALL_MODULES as string[]).includes(key) && !modules.has(key)) {
      modules.add(key);
      addedByIntent.push(key);
    }
  }
  if (addedByIntent.length > 0) {
    rationale.push(`Switched on ${unique(addedByIntent).join(', ')} because of what you said you want help with.`);
  }

  // Connectors: only ones that could genuinely serve the named apps.
  const connectors = new Set<ConnectorKey>(template.recommendedConnectors);
  const appsText = (answers.preferredApps ?? []).join(' ');
  for (const hint of APP_CONNECTOR_HINTS) {
    if (hint.re.test(appsText)) connectors.add(hint.connector);
  }
  if (modules.has('developer')) connectors.add('github');

  const privacy: PrivacyPreferences = {
    ...DEFAULT_PRIVACY,
    ...template.privacyDefaults,
    ...stripUndefined(answers.privacy ?? {}),
  };
  // Minor accounts never opt into remote AI during generation.
  if (answers.isMinorAccount) {
    privacy.allowRemoteAi = false;
    rationale.push('Remote AI is off because this account is marked as belonging to a minor.');
  }
  if (!privacy.allowRemoteAi) {
    rationale.push('No data will be sent to an AI provider until you turn that on in Privacy.');
  }

  const moduleList = ALL_MODULES.filter((m) => modules.has(m));
  const goalSeeds = (answers.primaryGoals ?? []).length
    ? (answers.primaryGoals ?? []).map((t): GoalSeed => ({ title: t, horizon: 'quarter' }))
    : template.goalSeeds;

  const cadence: Cadence = answers.reportingCadence ?? (answers.workingStyle === 'reactive' ? 'daily' : 'weekly');

  const config: Omit<BrainConfiguration, 'id' | 'version' | 'createdAt'> = {
    workspaceId,
    schemaVersion: LATEST_SCHEMA_VERSION,
    profile,
    displayName: answers.displayName?.trim() || template.label,
    intents: unique(answers.intents ?? []).slice(0, 20),
    modules: moduleList,
    knowledgeCategories: unique([...template.knowledgeCategories, ...(answers.focusAreas ?? [])]).slice(0, 24),
    goalHierarchy: goalSeeds,
    projectTaxonomy: template.projectTaxonomy,
    preferredMetrics: template.preferredMetrics,
    reportingCadence: cadence,
    recommendedConnectors: [...connectors],
    privacy,
    dashboardLayout: layoutFor(profile, moduleList),
    assistantInstructions: answers.assistantInstructions?.trim() ?? defaultInstructions(template.label),
    automationLevel: answers.automationLevel ?? 'review',
    workingStyle: answers.workingStyle ?? 'balanced',
    createdBy: 'derived',
  };

  rationale.push(
    config.automationLevel === 'automatic'
      ? 'Discovered projects will register themselves when confidence is high.'
      : 'Discovered projects will wait in a review queue for your approval.',
  );

  return {
    config,
    projectSeeds: (answers.currentProjects ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .slice(0, 50)
      .map((name) => ({ name, category: guessCategory(name, profile) })),
    goalSeeds,
    rationale,
  };
}

/** Picks a profile from the user's words when they skipped the template step. */
export function inferProfile(answers: OnboardingAnswers): BrainProfileKey | null {
  const text = [
    ...(answers.intents ?? []), ...(answers.focusAreas ?? []),
    ...(answers.preferredApps ?? []), ...(answers.currentProjects ?? []),
  ].join(' ').toLowerCase();
  if (text.trim() === '') return null;

  const scores: Array<[BrainProfileKey, number]> = [
    ['developer', count(text, /\b(code|repo|git|deploy|api|ci|bug|refactor|typescript|python|rust|library|sdk)\b/g)],
    ['founder', count(text, /\b(startup|founder|revenue|investor|customer|mrr|runway|pitch|company|saas)\b/g)],
    ['creator', count(text, /\b(video|content|post|reel|design|brand|audience|newsletter|podcast|publish)\b/g)],
    ['freelancer', count(text, /\b(client|invoice|contract|retainer|billable|freelance|proposal|scope)\b/g)],
    ['research', count(text, /\b(research|paper|hypothes|experiment|literature|citation|dataset|study)\b/g)],
    ['student', count(text, /\b(assignment|course|exam|semester|homework|lecture|school|college|syllabus)\b/g)],
    ['personal', count(text, /\b(habit|personal|home|family|health|budget|life|routine)\b/g)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores[0];
  return top && top[1] > 0 ? top[0] : null;
}

function guessCategory(name: string, profile: BrainProfileKey): string {
  if (/\b(app|site|web|api|service|cli|bot|library|sdk)\b/i.test(name)) return 'software';
  if (/\b(client|retainer)\b/i.test(name)) return 'client';
  if (/\b(course|exam|assignment)\b/i.test(name)) return 'study';
  if (/\b(paper|study|research)\b/i.test(name)) return 'research';
  const byProfile: Record<BrainProfileKey, string> = {
    developer: 'software', founder: 'business', creator: 'content', freelancer: 'client',
    research: 'research', student: 'study', personal: 'personal', custom: 'other',
  };
  return byProfile[profile];
}

function defaultInstructions(label: string): string {
  return [
    `You are helping with a ${label}.`,
    'Only state things supported by the records provided to you.',
    'When a record is missing, say what is missing instead of guessing.',
    'Label anything uncertain as uncertain, and cite the source of each claim.',
  ].join(' ');
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/* ---------------------------------------------------------------- */
/* Portable configuration file                                       */
/* ---------------------------------------------------------------- */

export const BRAIN_FILE_VERSION = 1;

export interface BrainConfigFile {
  $schema: 'https://ai-brain.dev/schema/brain.config.v1.json';
  fileVersion: number;
  exportedAt: string;
  profile: BrainProfileKey;
  displayName: string;
  intents: string[];
  modules: ModuleKey[];
  knowledgeCategories: string[];
  goalHierarchy: GoalSeed[];
  projectTaxonomy: string[];
  preferredMetrics: string[];
  reportingCadence: Cadence;
  recommendedConnectors: ConnectorKey[];
  privacy: PrivacyPreferences;
  dashboardLayout: BrainConfiguration['dashboardLayout'];
  assistantInstructions: string;
  automationLevel: BrainConfiguration['automationLevel'];
  workingStyle: BrainConfiguration['workingStyle'];
}

/** Serialises a configuration for `brain.config.json`. Carries no user records. */
export function toConfigFile(cfg: BrainConfiguration): BrainConfigFile {
  return {
    $schema: 'https://ai-brain.dev/schema/brain.config.v1.json',
    fileVersion: BRAIN_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    profile: cfg.profile,
    displayName: cfg.displayName,
    intents: cfg.intents,
    modules: cfg.modules,
    knowledgeCategories: cfg.knowledgeCategories,
    goalHierarchy: cfg.goalHierarchy,
    projectTaxonomy: cfg.projectTaxonomy,
    preferredMetrics: cfg.preferredMetrics,
    reportingCadence: cfg.reportingCadence,
    recommendedConnectors: cfg.recommendedConnectors,
    privacy: cfg.privacy,
    dashboardLayout: cfg.dashboardLayout,
    assistantInstructions: cfg.assistantInstructions,
    automationLevel: cfg.automationLevel,
    workingStyle: cfg.workingStyle,
  };
}

export class ConfigImportError extends Error {}

/**
 * Parses a `brain.config.json` from another installation.
 *
 * Unknown module keys and connector keys are dropped rather than trusted, so a
 * file from a newer version degrades instead of corrupting the workspace.
 */
export function fromConfigFile(raw: unknown, workspaceId: string): Omit<BrainConfiguration, 'id' | 'version' | 'createdAt'> {
  if (typeof raw !== 'object' || raw === null) throw new ConfigImportError('configuration must be a JSON object');
  const f = raw as Partial<BrainConfigFile>;
  if (typeof f.fileVersion !== 'number') throw new ConfigImportError('missing fileVersion');
  if (f.fileVersion > BRAIN_FILE_VERSION) {
    throw new ConfigImportError(`file version ${f.fileVersion} is newer than this installation supports (${BRAIN_FILE_VERSION})`);
  }
  const profile: BrainProfileKey = (f.profile && f.profile in PROFILE_TEMPLATES ? f.profile : 'custom') as BrainProfileKey;
  const modules = (Array.isArray(f.modules) ? f.modules : []).filter((m): m is ModuleKey =>
    (ALL_MODULES as string[]).includes(m as string),
  );
  const finalModules = modules.length > 0 ? modules : PROFILE_TEMPLATES[profile].modules;
  const knownConnectors: ConnectorKey[] = ['github', 'local-directory', 'claude-code', 'codex', 'markdown-import', 'conversation-import'];

  return {
    workspaceId,
    schemaVersion: LATEST_SCHEMA_VERSION,
    profile,
    displayName: typeof f.displayName === 'string' ? f.displayName.slice(0, 120) : PROFILE_TEMPLATES[profile].label,
    intents: strArr(f.intents),
    modules: finalModules,
    knowledgeCategories: strArr(f.knowledgeCategories),
    goalHierarchy: Array.isArray(f.goalHierarchy) ? (f.goalHierarchy as GoalSeed[]).slice(0, 50) : [],
    projectTaxonomy: strArr(f.projectTaxonomy),
    preferredMetrics: strArr(f.preferredMetrics),
    reportingCadence: (['daily', 'weekly', 'monthly', 'quarterly', 'manual'] as const).includes(f.reportingCadence as Cadence)
      ? (f.reportingCadence as Cadence)
      : 'weekly',
    recommendedConnectors: strArr(f.recommendedConnectors).filter((c): c is ConnectorKey =>
      knownConnectors.includes(c as ConnectorKey),
    ),
    privacy: { ...DEFAULT_PRIVACY, ...stripUndefined((f.privacy ?? {}) as PrivacyPreferences) },
    dashboardLayout:
      f.dashboardLayout && Array.isArray(f.dashboardLayout.widgets)
        ? f.dashboardLayout
        : layoutFor(profile, finalModules),
    assistantInstructions: typeof f.assistantInstructions === 'string' ? f.assistantInstructions.slice(0, 4000) : '',
    automationLevel: (['manual', 'review', 'automatic'] as const).includes(f.automationLevel as 'manual')
      ? (f.automationLevel as BrainConfiguration['automationLevel'])
      : 'review',
    workingStyle: (['deep-work', 'balanced', 'reactive'] as const).includes(f.workingStyle as 'balanced')
      ? (f.workingStyle as BrainConfiguration['workingStyle'])
      : 'balanced',
    createdBy: 'import',
  };
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return unique(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)).slice(0, 60);
}
