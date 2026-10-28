/**
 * AI BRAIN core.
 *
 * Zero runtime dependencies: storage is `node:sqlite`, crypto is
 * `node:crypto`, and there is no HTTP framework, ORM or validation library in
 * here. That is what lets the whole system install with `pnpm install` and run
 * with `pnpm dev` on a machine with nothing else set up.
 */
export type * from './domain/types.ts';
export * from './db/index.ts';
export * from './engines/index.ts';
export * from './connectors/index.ts';
export * from './ai/index.ts';
export * from './security/index.ts';
export * from './util/id.ts';
export * from './util/time.ts';
export * from './util/json.ts';
export * from './util/validate.ts';

export const CORE_VERSION = '0.1.0';
