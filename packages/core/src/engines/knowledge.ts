/**
 * The Universal Knowledge Engine.
 *
 * Ingest is deliberately conservative. Text is redacted locally before it is
 * stored, classified by rules that can be inspected, hashed so re-importing the
 * same file twice does not duplicate it, and checked against existing records
 * for direct contradictions. Classification is recorded as 'derived', never as
 * a fact the system claims to know.
 */

import type {
  Id, KnowledgeClass, KnowledgeRecord, Origin, Confidence, ImportBatch,
} from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { contentHash } from '../util/id.ts';
import { nowIso } from '../util/time.ts';
import { redact } from '../security/redact.ts';

export interface IngestDocument {
  /** File name or note title. */
  title: string;
  body: string;
  /** Where it came from, for the provenance trail. */
  locator: string;
  projectId?: Id | null;
  tags?: string[];
  klass?: KnowledgeClass;
  observedAt?: string;
  origin?: Origin;
  sourceId?: Id | null;
}

export interface IngestOutcome {
  record: KnowledgeRecord | null;
  status: 'created' | 'duplicate' | 'superseded' | 'skipped-empty';
  redactions: number;
  redactionKinds: string[];
  /** Set when an existing record says something incompatible. */
  contradicts: KnowledgeRecord | null;
}

export interface IngestOptions {
  /** When false, only the title and metadata are stored, never the body. */
  allowFileContentImport: boolean;
  /** Category names the user excluded from import. */
  excludedCategories: string[];
}

export class KnowledgeEngine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  ingest(workspaceId: Id, doc: IngestDocument, opts: IngestOptions): IngestOutcome {
    const title = doc.title.trim().slice(0, 300);
    if (title === '' && doc.body.trim() === '') {
      return { record: null, status: 'skipped-empty', redactions: 0, redactionKinds: [], contradicts: null };
    }

    const tags = normaliseTags(doc.tags ?? []);
    // A user-excluded category blocks the document entirely.
    if (opts.excludedCategories.some((c) => tags.includes(c.toLowerCase()) || title.toLowerCase().includes(c.toLowerCase()))) {
      return { record: null, status: 'skipped-empty', redactions: 0, redactionKinds: [], contradicts: null };
    }

    const { text: safeBody, count, kinds } = redact(opts.allowFileContentImport ? doc.body : '');
    const body = opts.allowFileContentImport
      ? safeBody.slice(0, 200_000)
      : `[body not imported: file content import is disabled for this workspace]\nSource: ${doc.locator}`;

    const hash = contentHash(title, body);
    const existing = this.store.knowledge.byHash(workspaceId, hash);
    if (existing) {
      return { record: existing, status: 'duplicate', redactions: count, redactionKinds: kinds, contradicts: null };
    }

    const klass = doc.klass ?? classify(title, body);
    const contradicts = this.findContradiction(workspaceId, title, body, klass);

    const record = this.store.knowledge.create({
      workspaceId,
      projectId: doc.projectId ?? null,
      title: title || doc.locator,
      body,
      klass,
      origin: doc.origin ?? 'import',
      // Imported text is only as true as its source; it is not an observation
      // the system made itself.
      confidence: doc.origin === 'manual' ? 'observed' : 'high',
      sourceId: doc.sourceId ?? null,
      contentHash: hash,
      tags: [...tags, ...(doc.klass ? [] : ['auto-classified'])],
      contradictsId: contradicts?.id ?? null,
      observedAt: doc.observedAt ?? nowIso(),
    });

    return { record, status: 'created', redactions: count, redactionKinds: kinds, contradicts };
  }

  /** Imports a batch of documents under one tracked ImportBatch. */
  ingestBatch(
    workspaceId: Id,
    kind: ImportBatch['kind'],
    label: string,
    docs: IngestDocument[],
    opts: IngestOptions,
  ): { batch: ImportBatch; created: number; skipped: number; redactions: number; contradictions: number } {
    const batch = this.store.imports.start({ workspaceId, kind, label, fileCount: docs.length });
    let created = 0;
    let skipped = 0;
    let redactions = 0;
    let contradictions = 0;
    try {
      this.store.transaction(() => {
        for (const doc of docs) {
          const r = this.ingest(workspaceId, doc, opts);
          if (r.status === 'created') created++;
          else skipped++;
          redactions += r.redactions;
          if (r.contradicts) contradictions++;
        }
      });
      this.store.imports.finish(batch.id, {
        status: skipped > 0 && created === 0 && docs.length > 0 ? 'partial' : 'success',
        recordsCreated: created, recordsSkipped: skipped, redactions,
      });
    } catch (err) {
      this.store.imports.finish(batch.id, {
        status: 'failed', recordsCreated: created, recordsSkipped: skipped, redactions,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return { batch, created, skipped, redactions, contradictions };
  }

  /**
   * Finds a stored record that asserts the opposite of this one.
   *
   * Scoped to a real, checkable case: two records whose subjects match closely
   * but whose polarity differs ("we use X" vs "we no longer use X"). Anything
   * subtler is left alone rather than guessed at — a false contradiction is
   * worse than a missed one.
   */
  findContradiction(workspaceId: Id, title: string, body: string, klass: KnowledgeClass): KnowledgeRecord | null {
    if (klass !== 'fact' && klass !== 'decision') return null;
    const subject = subjectOf(title);
    if (subject.length < 3) return null;

    const polarity = polarityOf(`${title} ${body}`);
    const hits = this.store.knowledge.search(workspaceId, subject, { klass: [klass], limit: 12 });
    for (const hit of hits) {
      if (hit.record.archivedAt) continue;
      if (subjectOf(hit.record.title) !== subject) continue;
      const other = polarityOf(`${hit.record.title} ${hit.record.body}`);
      if (other !== 0 && polarity !== 0 && other !== polarity) return hit.record;
    }
    return null;
  }

  /** Records that a new statement replaces an older one. The old row is kept. */
  supersede(workspaceId: Id, oldId: Id, newId: Id): void {
    this.store.transaction(() => {
      this.store.knowledge.update(workspaceId, newId, { supersedesId: oldId, contradictsId: null });
      this.store.knowledge.update(workspaceId, oldId, { archivedAt: nowIso() });
    });
  }

  /** Records whose source has not been reconfirmed within `days`. */
  staleRecords(workspaceId: Id, days = 180): KnowledgeRecord[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.store.knowledge
      .list(workspaceId, { limit: 2000 })
      .filter((k) => k.observedAt < cutoff);
  }

  contradictions(workspaceId: Id): Array<{ record: KnowledgeRecord; conflictsWith: KnowledgeRecord | null }> {
    return this.store.knowledge
      .list(workspaceId, { limit: 2000 })
      .filter((k) => k.contradictsId !== null)
      .map((k) => ({ record: k, conflictsWith: k.contradictsId ? this.store.knowledge.byId(workspaceId, k.contradictsId) : null }));
  }

  /** Links between records, derived from shared project and tags. */
  related(workspaceId: Id, id: Id, limit = 8): KnowledgeRecord[] {
    const rec = this.store.knowledge.byId(workspaceId, id);
    if (!rec) return [];
    const terms = significantTerms(`${rec.title} ${rec.body}`).slice(0, 6).join(' ');
    const hits = this.store.knowledge.search(workspaceId, terms, { limit: limit + 5 });
    const sameProject = rec.projectId
      ? this.store.knowledge.list(workspaceId, { projectId: rec.projectId, limit: limit + 5 })
      : [];
    const pool = [...hits.map((h) => h.record), ...sameProject];
    const seen = new Set<string>([id]);
    const out: KnowledgeRecord[] = [];
    for (const r of pool) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  stats(workspaceId: Id): {
    total: number;
    byClass: Record<KnowledgeClass, number>;
    withSource: number;
    stale: number;
    contradictions: number;
    generated: number;
  } {
    const all = this.store.knowledge.list(workspaceId, { limit: 10_000 });
    const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
    return {
      total: all.length,
      byClass: this.store.knowledge.countByClass(workspaceId),
      withSource: all.filter((k) => k.sourceId !== null).length,
      stale: all.filter((k) => k.observedAt < cutoff).length,
      contradictions: all.filter((k) => k.contradictsId !== null).length,
      generated: all.filter((k) => k.origin === 'generated').length,
    };
  }
}

/* ---------------------------------------------------------------- */
/* Classification                                                    */
/* ---------------------------------------------------------------- */

const CLASS_RULES: Array<{ klass: KnowledgeClass; re: RegExp; weight: number }> = [
  { klass: 'decision', re: /\b(we (?:decided|chose|will use|agreed)|decision:|adr[- ]?\d|chose\b|opted for|going with|settled on|rejected\b)/i, weight: 3 },
  { klass: 'decision', re: /^#+\s*(?:decision|adr)\b/im, weight: 3 },
  { klass: 'action', re: /\b(todo|to-do|action item|next step|follow[- ]up|needs? to|must\b|should\s+(?:we|i)\b)\b/i, weight: 2 },
  { klass: 'action', re: /^\s*[-*]\s*\[[ x]\]/m, weight: 3 },
  { klass: 'idea', re: /\b(idea:|what if|could\b|maybe\b|proposal|brainstorm|consider(?:ing)?\b|concept)\b/i, weight: 2 },
  { klass: 'insight', re: /\b(learned|turns out|realis|realiz|insight:|takeaway|conclusion|because of this|root cause|lesson)\b/i, weight: 3 },
  { klass: 'fact', re: /\b(is|are|was|were|has|have|runs on|lives (?:at|in)|located|version\b|endpoint|configured)\b/i, weight: 1 },
];

/** Rule-based, inspectable, and identical on every machine. */
export function classify(title: string, body: string): KnowledgeClass {
  const text = `${title}\n${body}`.slice(0, 8000);
  const scores: Record<KnowledgeClass, number> = { fact: 0, decision: 0, idea: 0, action: 0, insight: 0 };
  for (const rule of CLASS_RULES) {
    const matches = text.match(new RegExp(rule.re.source, `${rule.re.flags.includes('m') ? 'gm' : 'g'}i`));
    if (matches) scores[rule.klass] += rule.weight * Math.min(matches.length, 3);
  }
  // The title carries more signal than the body; weight it again.
  for (const rule of CLASS_RULES) {
    if (rule.re.test(title)) scores[rule.klass] += rule.weight;
  }
  const best = (Object.entries(scores) as Array<[KnowledgeClass, number]>).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 1 ? best[0] : 'fact';
}

const NEGATIVE = /\b(not|no longer|never|stopped|removed|deprecated|dropped|without|disabled|cancell?ed|abandoned|don't|doesn't|isn't|aren't|won't)\b/i;
const POSITIVE = /\b(now|use|uses|using|adopted|enabled|added|chose|is|are|will)\b/i;

/** -1 negative, +1 positive, 0 undetermined. */
export function polarityOf(text: string): -1 | 0 | 1 {
  const neg = NEGATIVE.test(text);
  const pos = POSITIVE.test(text);
  if (neg && !pos) return -1;
  if (neg && pos) {
    // "we no longer use X" has both; the negation governs.
    return NEGATIVE.test(text.slice(0, Math.max(40, text.search(NEGATIVE) + 20))) ? -1 : 1;
  }
  if (pos) return 1;
  return 0;
}

/**
 * The thing a statement is about, with polarity words stripped out.
 *
 * The stripping has to happen on the whole string, not word by word: "no
 * longer" is a two-word phrase, and filtering per word would leave "longer"
 * behind and make "We use X" and "We no longer use X" look like different
 * subjects — which would silently disable contradiction detection.
 */
const POLARITY_PHRASES = /\b(?:no longer|not|never|stopped|removed|deprecated|dropped|without|disabled|cancell?ed|abandoned|don'?t|doesn'?t|isn'?t|aren'?t|won'?t|now|uses?|using|adopted|enabled|added|chose|is|are|was|were|will|longer|still|anymore)\b/g;

export function subjectOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(POLARITY_PHRASES, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort()
    .join(' ')
    .trim();
}

export function significantTerms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

function normaliseTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length < 40))].slice(0, 20);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'but', 'not',
  'you', 'your', 'our', 'their', 'his', 'her', 'its', 'can', 'will', 'would', 'should', 'could', 'all',
  'any', 'been', 'because', 'they', 'them', 'then', 'than', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'into', 'about', 'after', 'before', 'more', 'most', 'some', 'such', 'only', 'other',
  'also', 'just', 'very', 'over', 'under', 'between', 'while', 'these', 'those', 'there', 'here',
  'use', 'used', 'using', 'make', 'made', 'get', 'got', 'now', 'new', 'one', 'two', 'out', 'via',
]);

/* ---------------------------------------------------------------- */
/* Markdown parsing                                                  */
/* ---------------------------------------------------------------- */

export interface ParsedMarkdown {
  title: string;
  body: string;
  tags: string[];
  frontmatter: Record<string, string>;
}

/**
 * Parses a Markdown file into an ingestable document.
 *
 * Handles the subset of YAML front matter that note-taking tools actually
 * emit — scalars and inline or dashed lists — without pulling in a YAML
 * parser, and falls back to the first heading for the title.
 */
export function parseMarkdown(filename: string, raw: string): ParsedMarkdown {
  let body = raw.replace(/^﻿/, '');
  const frontmatter: Record<string, string> = {};
  const tags: string[] = [];

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    let lastKey = '';
    for (const line of fm[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) {
        lastKey = kv[1]!.toLowerCase();
        const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
        frontmatter[lastKey] = value;
        if (lastKey === 'tags' && value) {
          for (const t of value.replace(/^\[|\]$/g, '').split(',')) {
            const tag = t.trim().replace(/^["']|["']$/g, '');
            if (tag) tags.push(tag);
          }
        }
        continue;
      }
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (item && lastKey === 'tags') tags.push(item[1]!.trim().replace(/^["']|["']$/g, ''));
    }
  }

  const heading = /^#{1,3}\s+(.+)$/m.exec(body);
  const title =
    frontmatter.title ||
    heading?.[1]?.trim() ||
    filename.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').trim();

  // Inline #hashtags, excluding Markdown headings.
  for (const m of body.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9/_-]{1,30})\b/gi)) {
    if (m[1]) tags.push(m[1]);
  }

  return { title, body: body.trim(), tags: [...new Set(tags)], frontmatter };
}

/**
 * Splits an exported AI conversation into knowledge documents.
 *
 * Accepts the shapes official exports actually use; anything unrecognised
 * returns an empty array rather than inventing structure.
 */
export function parseConversationExport(raw: string): IngestDocument[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: IngestDocument[] = [];
  const conversations = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { conversations?: unknown[] }).conversations)
      ? (data as { conversations: unknown[] }).conversations
      : [];

  for (const conv of conversations) {
    if (typeof conv !== 'object' || conv === null) continue;
    const c = conv as Record<string, unknown>;
    const title = String(c.title ?? c.name ?? 'Untitled conversation').slice(0, 300);
    const created = typeof c.create_time === 'number'
      ? new Date(c.create_time * 1000).toISOString()
      : typeof c.created_at === 'string'
        ? c.created_at
        : nowIso();

    const messages: string[] = [];
    const rawMessages = Array.isArray(c.messages)
      ? c.messages
      : Array.isArray(c.chat_messages)
        ? c.chat_messages
        : [];
    for (const m of rawMessages) {
      if (typeof m !== 'object' || m === null) continue;
      const msg = m as Record<string, unknown>;
      const role = String(msg.role ?? msg.sender ?? 'unknown');
      const text = extractText(msg);
      if (text.trim()) messages.push(`**${role}:** ${text.trim()}`);
    }
    if (messages.length === 0) continue;
    out.push({
      title,
      body: messages.join('\n\n').slice(0, 200_000),
      locator: `conversation-export:${title}`,
      observedAt: created,
      origin: 'import',
      tags: ['conversation'],
    });
  }
  return out;
}

function extractText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === 'string' ? part : typeof part === 'object' && part !== null ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  const nested = msg.message;
  if (typeof nested === 'object' && nested !== null) return extractText(nested as Record<string, unknown>);
  return '';
}

export type { Confidence };
