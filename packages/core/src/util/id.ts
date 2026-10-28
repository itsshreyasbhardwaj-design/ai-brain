import { randomUUID, randomBytes, createHash } from 'node:crypto';

/** Prefixed, sortable-enough identifiers. Readable in logs and URLs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable hash of meaningful content, used for duplicate detection. */
export function contentHash(...parts: string[]): string {
  const norm = parts
    .map((p) => p.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
    .join('\u0000');
  return sha256(norm).slice(0, 32);
}

export function slugify(input: string, fallback = 'item'): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s.length > 0 ? s : fallback;
}
