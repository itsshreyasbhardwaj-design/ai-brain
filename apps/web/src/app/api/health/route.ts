import { NextResponse } from 'next/server';
import { getStore } from '@/lib/server';
import { LATEST_SCHEMA_VERSION, pendingMigrations } from '@ai-brain/core/db';

/**
 * Health check for self-hosted deployments.
 *
 * Deliberately says nothing about the user: counts and configuration would be
 * an information leak on an endpoint that has to be reachable unauthenticated.
 */
export async function GET(): Promise<Response> {
  try {
    const store = getStore();
    const pending = pendingMigrations(store.db);
    return NextResponse.json({
      status: pending.length === 0 ? 'ok' : 'migrations-pending',
      schemaVersion: store.db.schemaVersion,
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
      pendingMigrations: pending,
    }, { status: pending.length === 0 ? 200 : 503 });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', error: err instanceof Error ? err.message : 'unknown' },
      { status: 503 },
    );
  }
}
