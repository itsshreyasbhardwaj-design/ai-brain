import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Credential encryption for connector tokens.
 *
 * AES-256-GCM with a key derived from APP_SECRET. Tokens are never stored in
 * plaintext and never returned to the browser; the API only ever reports
 * whether a credential exists.
 */
function keyFrom(secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error('APP_SECRET must be set to at least 16 characters before storing credentials');
  }
  return createHash('sha256').update(`ai-brain:v1:${secret}`).digest();
}

export function encryptSecret(plaintext: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(appSecret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(cipherText: string, appSecret: string): string {
  const [v, ivB64, tagB64, ctB64] = cipherText.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('malformed credential ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(appSecret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
