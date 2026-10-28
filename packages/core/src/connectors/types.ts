/**
 * The adapter interface every connector implements.
 *
 * A connector's only job is to turn an authorized source into source records,
 * project candidates, activity events and metrics. It never writes to the
 * database, never decides whether a project is new, and never reads anything
 * outside the allowlist it is handed. That separation is what makes a new
 * connector a contained piece of work and keeps the privacy rules in one place.
 */

import type {
  ConnectorKey, Iso, SourceRecord, ActivityEvent, Metric, Confidence,
} from '../domain/types.ts';
import type { ProjectCandidate } from '../engines/discovery.ts';
import type { IngestDocument } from '../engines/knowledge.ts';

/** Credentials and scope for one authorized account. Assembled by the caller. */
export interface ConnectorContext {
  connector: ConnectorKey;
  accountLabel: string;
  /** Decrypted at the call site and never logged. */
  credential: string | null;
  /** Repositories, directories or ids the user explicitly authorized. */
  allowlist: string[];
  /** Opaque incremental cursor from the previous run. */
  cursor: string | null;
  privacy: {
    excludedPaths: string[];
    excludedCategories: string[];
    allowFileContentImport: boolean;
  };
  /** Abort signal so a long sync can be cancelled. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling on items fetched in one run. */
  maxItems?: number;
}

export interface SourcePayload {
  kind: string;
  externalId: string;
  locator: string;
  url: string | null;
  payload: Record<string, unknown>;
  observedAt: Iso;
}

export interface ActivityPayload {
  /** Resolved to a project id by the caller via this source key. */
  projectSourceKey: string | null;
  kind: string;
  summary: string;
  url: string | null;
  actor: string | null;
  occurredAt: Iso;
  /** Links the event back to the source record it came from. */
  sourceExternalId: string | null;
}

export interface MetricPayload {
  projectSourceKey: string | null;
  key: string;
  label: string;
  value: number;
  unit: string;
  target?: number | null;
  observedAt: Iso;
}

export interface FetchResult {
  sources: SourcePayload[];
  candidates: ProjectCandidate[];
  activity: ActivityPayload[];
  metrics: MetricPayload[];
  documents: IngestDocument[];
  /** Cursor to persist for the next incremental run. */
  cursor: string | null;
  /** True when more data remains, so the caller can schedule another page. */
  hasMore: boolean;
  /** Non-fatal problems. A run with these finishes as 'partial'. */
  warnings: string[];
  /** Items skipped by the privacy rules, reported honestly in sync stats. */
  skippedByPrivacy: number;
  rateLimitWaits: number;
  retries: number;
}

export interface ConnectorAdapter {
  key: ConnectorKey;
  /** Confirms the credential works and reports who it belongs to. */
  verify(ctx: ConnectorContext): Promise<{ ok: boolean; accountLabel: string; scopes: string[]; error?: string }>;
  /** One incremental pass. Must be safe to call repeatedly. */
  fetch(ctx: ConnectorContext): Promise<FetchResult>;
}

export function emptyFetchResult(): FetchResult {
  return {
    sources: [], candidates: [], activity: [], metrics: [], documents: [],
    cursor: null, hasMore: false, warnings: [], skippedByPrivacy: 0,
    rateLimitWaits: 0, retries: 0,
  };
}

export type { ProjectCandidate, SourceRecord, ActivityEvent, Metric, Confidence, IngestDocument };
