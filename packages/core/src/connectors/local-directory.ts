/**
 * Local directory connector.
 *
 * Scans only directories the user explicitly authorized, and only to a bounded
 * depth. Project detection relies on markers that mean something ("there is a
 * .git here", "there is a package.json here") rather than on folder names, and
 * monorepo members are detected from workspace declarations so they attach to
 * their parent instead of appearing as unrelated projects.
 *
 * The secret-file denylist in security/redact.ts is applied to every path
 * before it is opened, so an authorized directory containing a .env or an SSH
 * key does not leak it into the knowledge base.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import type { ConnectorAdapter, ConnectorContext, FetchResult, SourcePayload } from './types.ts';
import { emptyFetchResult } from './types.ts';
import type { ProjectCandidate } from '../engines/discovery.ts';
import type { IngestDocument } from '../engines/knowledge.ts';
import type { ProjectCategory, Lifecycle } from '../domain/types.ts';
import { isExcludedPath } from '../security/redact.ts';
import { contentHash } from '../util/id.ts';
import { parseMarkdown } from '../engines/knowledge.ts';

/** Files that mark a directory as a project root, with what they imply. */
const PROJECT_MARKERS: Array<{ file: string; category: ProjectCategory; tag: string }> = [
  { file: 'package.json', category: 'software', tag: 'node' },
  { file: 'pyproject.toml', category: 'software', tag: 'python' },
  { file: 'requirements.txt', category: 'software', tag: 'python' },
  { file: 'Cargo.toml', category: 'software', tag: 'rust' },
  { file: 'go.mod', category: 'software', tag: 'go' },
  { file: 'pom.xml', category: 'software', tag: 'java' },
  { file: 'build.gradle', category: 'software', tag: 'java' },
  { file: 'Gemfile', category: 'software', tag: 'ruby' },
  { file: 'composer.json', category: 'software', tag: 'php' },
  { file: 'Package.swift', category: 'software', tag: 'swift' },
  { file: 'CMakeLists.txt', category: 'software', tag: 'cpp' },
  { file: 'Makefile', category: 'software', tag: 'make' },
];

const DOC_EXTENSIONS = /\.(md|markdown|txt)$/i;
const MAX_DEPTH = 3;
const MAX_DOC_BYTES = 512 * 1024;

export class LocalDirectoryConnector implements ConnectorAdapter {
  readonly key = 'local-directory' as const;

  async verify(ctx: ConnectorContext): Promise<{ ok: boolean; accountLabel: string; scopes: string[]; error?: string }> {
    if (ctx.allowlist.length === 0) {
      return { ok: false, accountLabel: '', scopes: [], error: 'authorize at least one directory before saving this connection' };
    }
    const unreadable: string[] = [];
    for (const dir of ctx.allowlist) {
      try {
        const st = await stat(resolve(dir));
        if (!st.isDirectory()) unreadable.push(`${dir} (not a directory)`);
      } catch (err) {
        unreadable.push(`${dir} (${err instanceof Error ? err.message : 'unreadable'})`);
      }
    }
    if (unreadable.length > 0) {
      return { ok: false, accountLabel: '', scopes: [], error: `cannot read: ${unreadable.join('; ')}` };
    }
    return { ok: true, accountLabel: `${ctx.allowlist.length} authorized director${ctx.allowlist.length === 1 ? 'y' : 'ies'}`, scopes: ['read'] };
  }

  async fetch(ctx: ConnectorContext): Promise<FetchResult> {
    const out = emptyFetchResult();
    const maxItems = ctx.maxItems ?? 400;
    const since = ctx.cursor ? new Date(ctx.cursor).getTime() : 0;
    let newest = since;

    for (const rootRaw of ctx.allowlist) {
      const root = resolve(rootRaw);
      try {
        const st = await stat(root);
        if (!st.isDirectory()) { out.warnings.push(`${rootRaw} is not a directory; skipped.`); continue; }
      } catch (err) {
        out.warnings.push(`${rootRaw} could not be read: ${err instanceof Error ? err.message : 'unknown error'}`);
        continue;
      }

      const found = await this.scan(root, root, 0, ctx, out, maxItems);
      for (const dir of found) {
        if (out.sources.length >= maxItems) { out.hasMore = true; break; }
        const mtime = dir.mtimeMs;
        if (mtime > newest) newest = mtime;

        const externalId = `dir:${dir.path}`;
        const observedAt = new Date().toISOString();
        const payload: Record<string, unknown> = {
          path: dir.path, name: dir.name, markers: dir.markers, tags: dir.tags,
          isGitRepo: dir.isGitRepo, workspaceParent: dir.workspaceParent,
          modifiedAt: new Date(mtime).toISOString(),
          declaredName: dir.declaredName, declaredDescription: dir.declaredDescription,
        };
        const source: SourcePayload = {
          kind: 'directory', externalId, locator: dir.path, url: null, payload, observedAt,
        };
        out.sources.push(source);

        const candidate: ProjectCandidate = {
          connector: 'local-directory',
          externalId,
          name: dir.declaredName || dir.name,
          description: dir.declaredDescription ?? '',
          category: dir.category,
          lifecycle: lifecycleFromMtime(mtime),
          tags: dir.tags,
          locator: dir.path,
          sourceId: null,
          lastActivityAt: new Date(mtime).toISOString(),
          aliases: dir.declaredName && dir.declaredName !== dir.name ? [dir.name] : [],
          // A .git directory is strong evidence; a lone Makefile is weaker.
          connectorConfidence: dir.isGitRepo ? 0.9 : dir.markers.length > 1 ? 0.82 : 0.68,
        };
        if (dir.workspaceParent) candidate.parentExternalId = `dir:${dir.workspaceParent}`;
        out.candidates.push(candidate);

        out.activity.push({
          projectSourceKey: `local-directory:${externalId}`,
          kind: 'directory.modified',
          summary: `Local directory last modified ${new Date(mtime).toISOString().slice(0, 10)}`,
          url: null, actor: null,
          occurredAt: new Date(mtime).toISOString(),
          sourceExternalId: externalId,
        });

        if (ctx.privacy.allowFileContentImport) {
          for (const doc of dir.documents) out.documents.push(doc);
        } else if (dir.documents.length > 0) {
          out.skippedByPrivacy += dir.documents.length;
        }
      }
    }

    out.cursor = newest > 0 ? new Date(newest).toISOString() : ctx.cursor;
    return out;
  }

  /** Depth-bounded walk. Returns the project roots it recognised. */
  private async scan(
    root: string,
    dir: string,
    depth: number,
    ctx: ConnectorContext,
    out: FetchResult,
    maxItems: number,
  ): Promise<DetectedDir[]> {
    if (depth > MAX_DEPTH || out.sources.length >= maxItems) return [];
    if (isExcludedPath(dir, ctx.privacy.excludedPaths)) { out.skippedByPrivacy++; return []; }

    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      out.warnings.push(`${dir}: ${err instanceof Error ? err.message : 'unreadable'}`);
      return [];
    }

    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const isGitRepo = dirNames.includes('.git');
    const markers = PROJECT_MARKERS.filter((m) => fileNames.has(m.file));
    const isProject = isGitRepo || markers.length > 0;

    const results: DetectedDir[] = [];

    if (isProject && depth > 0) {
      const detected = await this.describe(dir, markers, isGitRepo, fileNames, ctx, out);
      results.push(detected);

      // Monorepo members: resolve declared workspace globs one level down.
      for (const childName of detected.workspaceDirs) {
        const childPath = join(dir, childName);
        if (isExcludedPath(childPath, ctx.privacy.excludedPaths)) { out.skippedByPrivacy++; continue; }
        try {
          const st = await stat(childPath);
          if (!st.isDirectory()) continue;
        } catch { continue; }
        const childEntries = (await readdir(childPath, { withFileTypes: true }).catch(() => [])) as Dirent[];
        const childFiles = new Set(childEntries.filter((e) => e.isFile()).map((e) => e.name));
        const childMarkers = PROJECT_MARKERS.filter((m) => childFiles.has(m.file));
        if (childMarkers.length === 0) continue;
        const child = await this.describe(childPath, childMarkers, false, childFiles, ctx, out);
        child.workspaceParent = dir;
        results.push(child);
      }
      // A recognised project is not descended into further; its own files are
      // its business, and this is what keeps the scan cheap.
      return results;
    }

    for (const name of dirNames) {
      if (name.startsWith('.') && name !== '.') continue;
      const child = join(dir, name);
      if (isExcludedPath(child, ctx.privacy.excludedPaths)) { out.skippedByPrivacy++; continue; }
      results.push(...(await this.scan(root, child, depth + 1, ctx, out, maxItems)));
      if (out.sources.length + results.length >= maxItems) break;
    }
    return results;
  }

  private async describe(
    dir: string,
    markers: Array<{ file: string; category: ProjectCategory; tag: string }>,
    isGitRepo: boolean,
    fileNames: Set<string>,
    ctx: ConnectorContext,
    out: FetchResult,
  ): Promise<DetectedDir> {
    let mtimeMs = 0;
    try { mtimeMs = (await stat(dir)).mtimeMs; } catch { mtimeMs = Date.now(); }

    let declaredName = '';
    let declaredDescription = '';
    const workspaceDirs: string[] = [];
    const tags = [...new Set(markers.map((m) => m.tag))];

    // package.json tells us the real name, the description and the workspaces.
    if (fileNames.has('package.json')) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { name?: string; description?: string; workspaces?: string[] | { packages?: string[] } };
        if (typeof pkg.name === 'string') declaredName = pkg.name.replace(/^@[^/]+\//, '');
        if (typeof pkg.description === 'string') declaredDescription = pkg.description.slice(0, 500);
        const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
        for (const glob of ws ?? []) {
          // Resolve only the common "dir/*" shape; anything fancier is left
          // to be discovered as its own project on a later scan.
          const m = /^([^*]+)\/\*$/.exec(glob);
          if (m?.[1]) {
            const sub = m[1].replace(/\/$/, '');
            const subEntries = (await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) as Dirent[];
            for (const e of subEntries) if (e.isDirectory()) workspaceDirs.push(join(sub, e.name));
          }
        }
      } catch (err) {
        out.warnings.push(`${dir}/package.json could not be parsed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    if (fileNames.has('pnpm-workspace.yaml')) {
      try {
        const raw = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
        for (const m of raw.matchAll(/^\s*-\s*['"]?([^'"\n]+?)\/\*['"]?\s*$/gm)) {
          const sub = m[1]!.trim();
          const subEntries = (await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) as Dirent[];
          for (const e of subEntries) if (e.isDirectory()) workspaceDirs.push(join(sub, e.name));
        }
      } catch { /* optional file */ }
    }

    // Documentation worth importing: README and a docs/ folder, nothing deeper.
    const documents: IngestDocument[] = [];
    if (ctx.privacy.allowFileContentImport) {
      for (const name of fileNames) {
        if (!DOC_EXTENSIONS.test(name)) continue;
        if (!/^(readme|changelog|contributing|architecture|notes?|decisions?|adr)/i.test(name)) continue;
        const doc = await this.readDoc(join(dir, name), ctx, out);
        if (doc) documents.push(doc);
      }
      const docsDir = join(dir, 'docs');
      const docEntries = (await readdir(docsDir, { withFileTypes: true }).catch(() => [])) as Dirent[];
      for (const e of docEntries.slice(0, 30)) {
        if (!e.isFile() || !DOC_EXTENSIONS.test(e.name)) continue;
        const doc = await this.readDoc(join(docsDir, e.name), ctx, out);
        if (doc) documents.push(doc);
      }
    }

    return {
      path: dir,
      name: basename(dir),
      declaredName,
      declaredDescription,
      markers: markers.map((m) => m.file).concat(isGitRepo ? ['.git'] : []),
      tags,
      category: markers[0]?.category ?? 'software',
      isGitRepo,
      mtimeMs,
      workspaceDirs,
      workspaceParent: null,
      documents,
    };
  }

  private async readDoc(path: string, ctx: ConnectorContext, out: FetchResult): Promise<IngestDocument | null> {
    if (isExcludedPath(path, ctx.privacy.excludedPaths)) { out.skippedByPrivacy++; return null; }
    try {
      const st = await stat(path);
      if (st.size > MAX_DOC_BYTES) {
        out.warnings.push(`${path} is ${Math.round(st.size / 1024)} KB and was skipped (limit ${MAX_DOC_BYTES / 1024} KB).`);
        return null;
      }
      const raw = await readFile(path, 'utf8');
      const parsed = parseMarkdown(basename(path), raw);
      return {
        title: parsed.title,
        body: parsed.body,
        locator: path,
        tags: [...parsed.tags, 'local-directory'],
        observedAt: new Date(st.mtimeMs).toISOString(),
        origin: 'connector',
      };
    } catch (err) {
      out.warnings.push(`${path}: ${err instanceof Error ? err.message : 'unreadable'}`);
      return null;
    }
  }
}

interface DetectedDir {
  path: string;
  name: string;
  declaredName: string;
  declaredDescription: string;
  markers: string[];
  tags: string[];
  category: ProjectCategory;
  isGitRepo: boolean;
  mtimeMs: number;
  workspaceDirs: string[];
  workspaceParent: string | null;
  documents: IngestDocument[];
}

function lifecycleFromMtime(mtimeMs: number): Lifecycle {
  const days = (Date.now() - mtimeMs) / 86_400_000;
  if (days > 365) return 'archived';
  if (days > 90) return 'paused';
  return 'active';
}

export function dirPayloadHash(payload: Record<string, unknown>): string {
  return contentHash(
    String(payload.path ?? ''), String(payload.modifiedAt ?? ''),
    String(payload.declaredName ?? ''), String(payload.declaredDescription ?? ''),
    JSON.stringify(payload.markers ?? []),
  );
}

/** Guards against an allowlist entry that would authorize a whole home dir. */
export function isTooBroad(dir: string): boolean {
  const r = resolve(dir);
  const parts = r.split(sep).filter(Boolean);
  if (parts.length <= 1) return true;
  if (/^\/(?:Users|home)\/[^/]+$/.test(r)) return true;
  return false;
}
