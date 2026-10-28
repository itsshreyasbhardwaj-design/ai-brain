/**
 * Operating profiles.
 *
 * A profile is a preset over one shared modular architecture — not a separate
 * application. Switching profile changes which modules are on, which widgets
 * the dashboard shows and which starting categories exist; it never moves or
 * deletes a record. That is what makes "change your profile later" safe.
 */

import type {
  BrainProfileKey, ConnectorKey, DashboardLayout, GoalSeed, ModuleKey,
} from '../domain/types.ts';

export interface ProfileTemplate {
  key: BrainProfileKey;
  label: string;
  tagline: string;
  /** Who this is for, shown during onboarding. */
  audience: string;
  modules: ModuleKey[];
  knowledgeCategories: string[];
  projectTaxonomy: string[];
  preferredMetrics: string[];
  goalSeeds: GoalSeed[];
  recommendedConnectors: ConnectorKey[];
  widgets: string[];
  /** Extra protections applied on top of the user's own choices. */
  privacyDefaults?: { allowRemoteAi?: boolean; allowFileContentImport?: boolean };
}

/** Widgets every profile gets, in this order, before profile-specific ones. */
const BASE_WIDGETS = ['priorities', 'active-projects', 'recent-activity'];

export const PROFILE_TEMPLATES: Record<BrainProfileKey, ProfileTemplate> = {
  founder: {
    key: 'founder',
    label: 'Founder Brain',
    tagline: 'Portfolio, revenue, and the decisions behind them.',
    audience: 'Startup founders and entrepreneurs running one or more businesses.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'decisions', 'business', 'resources', 'reports', 'assistant', 'integrations'],
    knowledgeCategories: ['Strategy', 'Customers', 'Market', 'Operations', 'Fundraising', 'Hiring', 'Metrics'],
    projectTaxonomy: ['Company', 'Product', 'Growth initiative', 'Operations', 'Fundraise'],
    preferredMetrics: ['revenue', 'active_customers', 'burn', 'runway_months', 'pipeline_value'],
    goalSeeds: [
      { title: 'Grow revenue', horizon: 'year', children: [{ title: 'Hit this quarter’s revenue target', horizon: 'quarter' }] },
      { title: 'Reach sustainable operations', horizon: 'long-term' },
    ],
    recommendedConnectors: ['markdown-import', 'github'],
    widgets: [...BASE_WIDGETS, 'business-summary', 'resource-usage', 'decisions', 'risks', 'goals', 'weekly-progress'],
  },
  developer: {
    key: 'developer',
    label: 'Developer Brain',
    tagline: 'Every repository, deployment and decision in one place.',
    audience: 'Software and AI engineers who lose track of their own projects.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'decisions', 'developer', 'resources', 'reports', 'assistant', 'integrations'],
    knowledgeCategories: ['Architecture', 'Decisions (ADR)', 'Runbooks', 'Debugging notes', 'Dependencies', 'Ideas'],
    projectTaxonomy: ['Application', 'Library', 'Service', 'Tool', 'Experiment', 'Infrastructure'],
    preferredMetrics: ['open_issues', 'open_pull_requests', 'stars', 'commits_30d', 'ci_pass_rate'],
    goalSeeds: [
      { title: 'Ship what I start', horizon: 'year', children: [{ title: 'Finish or archive every stale project', horizon: 'quarter' }] },
      { title: 'Keep dependencies and CI healthy', horizon: 'quarter' },
    ],
    recommendedConnectors: ['github', 'local-directory', 'claude-code', 'codex'],
    widgets: [...BASE_WIDGETS, 'developer-health', 'discovered-projects', 'connected-sources', 'risks', 'knowledge-updates', 'weekly-progress'],
  },
  creator: {
    key: 'creator',
    label: 'Creator Brain',
    tagline: 'Pipeline, publishing and the work behind each piece.',
    audience: 'Designers, writers, video and audio creators.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'calendar', 'resources', 'reports', 'assistant', 'integrations'],
    knowledgeCategories: ['Ideas', 'Scripts & drafts', 'References', 'Brand', 'Audience notes', 'Campaigns'],
    projectTaxonomy: ['Series', 'Single piece', 'Campaign', 'Collaboration', 'Client work'],
    preferredMetrics: ['pieces_published', 'pieces_in_progress', 'audience_size', 'engagement_rate'],
    goalSeeds: [
      { title: 'Publish consistently', horizon: 'quarter' },
      { title: 'Build an audience that compounds', horizon: 'year' },
    ],
    recommendedConnectors: ['markdown-import'],
    widgets: [...BASE_WIDGETS, 'upcoming-commitments', 'goals', 'knowledge-updates', 'weekly-progress'],
  },
  freelancer: {
    key: 'freelancer',
    label: 'Freelancer Brain',
    tagline: 'Clients, deliverables, deadlines and where the hours went.',
    audience: 'Independent professionals juggling several clients.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'decisions', 'resources', 'calendar', 'reports', 'assistant', 'integrations'],
    knowledgeCategories: ['Clients', 'Contracts', 'Deliverables', 'Rates & scope', 'Process', 'Templates'],
    projectTaxonomy: ['Client engagement', 'Retainer', 'Fixed-scope project', 'Internal'],
    preferredMetrics: ['billable_minutes', 'invoiced_amount', 'outstanding_amount', 'active_clients'],
    goalSeeds: [
      { title: 'Keep a predictable income', horizon: 'year', children: [{ title: 'Fill next quarter’s capacity', horizon: 'quarter' }] },
      { title: 'Stop undercharging', horizon: 'quarter' },
    ],
    recommendedConnectors: ['markdown-import', 'github'],
    widgets: [...BASE_WIDGETS, 'upcoming-commitments', 'resource-usage', 'financial-summary', 'risks', 'weekly-progress'],
  },
  research: {
    key: 'research',
    label: 'Research Brain',
    tagline: 'Sources, hypotheses, evidence and what you concluded.',
    audience: 'Researchers and knowledge workers managing long investigations.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'decisions', 'reports', 'assistant', 'integrations'],
    knowledgeCategories: ['Literature', 'Sources', 'Hypotheses', 'Experiments', 'Evidence', 'Findings', 'Open questions'],
    projectTaxonomy: ['Research project', 'Literature review', 'Experiment', 'Paper', 'Dataset'],
    preferredMetrics: ['sources_reviewed', 'experiments_run', 'findings_recorded'],
    goalSeeds: [
      { title: 'Answer the central research question', horizon: 'long-term' },
      { title: 'Close this quarter’s open questions', horizon: 'quarter' },
    ],
    recommendedConnectors: ['markdown-import', 'conversation-import'],
    widgets: [...BASE_WIDGETS, 'knowledge-updates', 'goals', 'risks', 'weekly-progress'],
  },
  personal: {
    key: 'personal',
    label: 'Personal Brain',
    tagline: 'Goals, commitments and decisions, without the noise.',
    audience: 'Anyone who wants one trustworthy place for their own life admin.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'decisions', 'productivity', 'resources', 'calendar', 'reports', 'assistant'],
    knowledgeCategories: ['Notes', 'Decisions', 'Important documents', 'Health', 'Finance', 'Home', 'Learning'],
    projectTaxonomy: ['Personal project', 'Commitment', 'Household', 'Learning', 'Admin'],
    preferredMetrics: ['habit_streak', 'monthly_spend', 'tasks_completed'],
    goalSeeds: [
      { title: 'Keep what matters from slipping', horizon: 'quarter' },
      { title: 'Build one habit that sticks', horizon: 'year' },
    ],
    recommendedConnectors: ['markdown-import'],
    widgets: [...BASE_WIDGETS, 'personal-goals', 'upcoming-commitments', 'financial-summary', 'weekly-progress'],
  },
  student: {
    key: 'student',
    label: 'Student Brain',
    tagline: 'Assignments, deadlines, notes and what you are actually learning.',
    audience: 'Students who chose academic organisation for themselves.',
    modules: ['projects', 'knowledge', 'tasks', 'goals', 'calendar', 'reports', 'assistant'],
    knowledgeCategories: ['Course notes', 'Assignments', 'Study materials', 'Research', 'Exam prep'],
    projectTaxonomy: ['Course', 'Assignment', 'Project', 'Exam', 'Application'],
    preferredMetrics: ['assignments_submitted', 'study_minutes', 'upcoming_deadlines'],
    goalSeeds: [
      { title: 'Finish the term without last-minute panic', horizon: 'quarter' },
      { title: 'Learn something I chose for myself', horizon: 'year' },
    ],
    recommendedConnectors: ['markdown-import'],
    widgets: [...BASE_WIDGETS, 'upcoming-commitments', 'goals', 'knowledge-updates'],
    // Academic material stays local and out of AI prompts unless explicitly enabled.
    privacyDefaults: { allowRemoteAi: false, allowFileContentImport: false },
  },
  custom: {
    key: 'custom',
    label: 'Custom Brain',
    tagline: 'Start from nothing and switch on only what you need.',
    audience: 'People who already know how they want to work.',
    modules: ['projects', 'knowledge', 'tasks'],
    knowledgeCategories: ['Notes'],
    projectTaxonomy: ['Project'],
    preferredMetrics: [],
    goalSeeds: [],
    recommendedConnectors: [],
    widgets: BASE_WIDGETS,
  },
};

export const ALL_MODULES: ModuleKey[] = [
  'projects', 'knowledge', 'tasks', 'goals', 'decisions', 'developer', 'business',
  'resources', 'calendar', 'reports', 'productivity', 'assistant', 'integrations',
];

export const MODULE_INFO: Record<ModuleKey, { label: string; description: string }> = {
  projects: { label: 'Projects', description: 'Project records, passports and automatic discovery.' },
  knowledge: { label: 'Knowledge', description: 'Searchable facts, decisions, ideas, actions and insights.' },
  tasks: { label: 'Tasks', description: 'What needs doing, with priorities and due dates.' },
  goals: { label: 'Goals', description: 'Goal hierarchy with progress you maintain or derive.' },
  decisions: { label: 'Decisions', description: 'Decision records with rationale and outcomes.' },
  developer: { label: 'Developer Intelligence', description: 'Repositories, CI, dependencies and deployments.' },
  business: { label: 'Business Intelligence', description: 'Revenue, customers and operational measures.' },
  resources: { label: 'Resource Optimization', description: 'Time, money, tools and where they go.' },
  calendar: { label: 'Calendar', description: 'Upcoming commitments and deadlines.' },
  reports: { label: 'Reports', description: 'Daily to quarterly reviews over verified records.' },
  productivity: { label: 'Personal Productivity', description: 'Habits, routines and focus sessions.' },
  assistant: { label: 'AI Assistant', description: 'Grounded questions over your own data.' },
  integrations: { label: 'Integrations', description: 'Connected accounts, sync health and imports.' },
};

/** Widget catalogue. `requires` gates a widget on an enabled module. */
export const WIDGET_CATALOG: Record<string, { label: string; requires: ModuleKey | null; span: number }> = {
  priorities: { label: 'Current priorities', requires: 'tasks', span: 6 },
  'active-projects': { label: 'Active projects', requires: 'projects', span: 6 },
  'discovered-projects': { label: 'Newly discovered', requires: 'projects', span: 4 },
  'recent-activity': { label: 'Recent activity', requires: null, span: 6 },
  'upcoming-commitments': { label: 'Upcoming', requires: 'tasks', span: 4 },
  'resource-usage': { label: 'Resource usage', requires: 'resources', span: 4 },
  'financial-summary': { label: 'Recurring costs', requires: 'resources', span: 4 },
  decisions: { label: 'Recent decisions', requires: 'decisions', span: 4 },
  risks: { label: 'Risks and blockers', requires: 'projects', span: 4 },
  'connected-sources': { label: 'Connected sources', requires: 'integrations', span: 4 },
  'knowledge-updates': { label: 'Knowledge updates', requires: 'knowledge', span: 4 },
  'personal-goals': { label: 'Personal goals', requires: 'goals', span: 6 },
  goals: { label: 'Goals', requires: 'goals', span: 6 },
  'weekly-progress': { label: 'This week', requires: null, span: 6 },
  'financial-summary-business': { label: 'Business summary', requires: 'business', span: 6 },
  'business-summary': { label: 'Business summary', requires: 'business', span: 6 },
  'developer-health': { label: 'Developer health', requires: 'developer', span: 6 },
  'ai-recommendations': { label: 'Recommended actions', requires: 'assistant', span: 6 },
};

/** Builds a layout containing only widgets whose module is enabled. */
export function layoutFor(profile: BrainProfileKey, modules: ModuleKey[]): DashboardLayout {
  const t = PROFILE_TEMPLATES[profile];
  const keys = [...t.widgets, 'ai-recommendations'];
  const widgets = keys
    .filter((k, i) => keys.indexOf(k) === i)
    .map((key) => {
      const meta = WIDGET_CATALOG[key];
      if (!meta) return null;
      if (meta.requires && !modules.includes(meta.requires)) return null;
      return { key, span: meta.span, visible: true };
    })
    .filter((w): w is { key: string; span: number; visible: boolean } => w !== null);
  return { columns: 12, widgets };
}
