import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * scrypt via node:crypto. No bcrypt/argon2 native dependency, which keeps
 * `pnpm install` free of a compiler step on every platform.
 */
const N = 2 ** 15; // ~32 MiB of memory per hash
const KEYLEN = 64;

export function hashPassword(plain: string): string {
  if (plain.length < 10) throw new Error('password must be at least 10 characters');
  const salt = randomBytes(16);
  const key = scryptSync(plain.normalize('NFKC'), salt, KEYLEN, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(key, 'base64');
  let actual: Buffer;
  try {
    actual = scryptSync(plain.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
