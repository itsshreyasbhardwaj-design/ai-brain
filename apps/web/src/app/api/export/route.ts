import { NextResponse } from 'next/server';
import { requireContextOrThrow, engines } from '@/lib/server';
import { toConfigFile } from '@ai-brain/core/engines';
import { buildContextPackage, renderContextPackageMarkdown } from '@ai-brain/core/ai';
import { AuthError } from '@ai-brain/core/engines';

/**
 * Data export.
 *
 * Three formats, all credential-free: the full dump for leaving or moving, the
 * configuration alone for sharing a setup, and a context package for an AI
 * tool that cannot reach the MCP server.
 */
export async function GET(request: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await requireContextOrThrow();
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return NextResponse.json({ error: 'not signed in' }, { status });
  }

  const format = new URL(request.url).searchParams.get('format') ?? 'full';
  const stamp = new Date().toISOString().slice(0, 10);
  const download = (body: string, filename: string, type: string): Response =>
    new Response(body, {
      headers: {
        'content-type': type,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });

  if (format === 'config') {
    if (!ctx.config) return NextResponse.json({ error: 'this workspace has no configuration' }, { status: 404 });
    return download(JSON.stringify(toConfigFile(ctx.config), null, 2), 'brain.config.json', 'application/json');
  }

  if (format === 'context' || format === 'context-md') {
    const pkg = buildContextPackage(ctx.store, ctx.workspace.id, ctx.config);
    return format === 'context-md'
      ? download(renderContextPackageMarkdown(pkg), `ai-brain-context-${stamp}.md`, 'text/markdown; charset=utf-8')
      : download(JSON.stringify(pkg, null, 2), `ai-brain-context-${stamp}.json`, 'application/json');
  }

  const data = engines(ctx.store).portability.export(ctx.workspace.id);
  ctx.store.audit.log({
    workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: 'workspace.exported',
    subject: `workspace:${ctx.workspace.id}`,
    detail: { projects: data.projects.length, knowledge: data.knowledge.length },
  });
  return download(JSON.stringify(data, null, 2), `ai-brain-export-${stamp}.json`, 'application/json');
}
