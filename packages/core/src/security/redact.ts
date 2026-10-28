/**
 * Local redaction for imported files.
 *
 * Runs before anything is written to the database and before any text reaches
 * an AI provider, so secrets in a user's notes do not silently become part of
 * their knowledge base or an outbound prompt.
 */

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'private-key', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer-token', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'connection-string', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'<>]*:[^\s"'<>@]+@[^\s"'<>]+/g },
  { kind: 'env-assignment', re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'\n]{8,})["']?/g },
  { kind: 'credit-card', re: /\b(?:\d[ -]*?){13,16}\b/g },
];

export function redact(text: string): RedactionResult {
  let out = text;
  let count = 0;
  const kinds = new Set<string>();

  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match, g1: string | undefined) => {
      if (kind === 'credit-card') {
        const digits = match.replace(/\D/g, '');
        if (!luhn(digits)) return match;
      }
      count++;
      kinds.add(kind);
      if (kind === 'env-assignment' && g1) return `${g1}=[redacted:${kind}]`;
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, count, kinds: [...kinds] };
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when a path should never be read, even inside an authorized directory. */
export function isExcludedPath(path: string, extraGlobs: string[] = []): boolean {
  const p = path.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? '';
  const DEFAULT_DENY = [
    '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc',
    'credentials', 'credentials.json', '.pgpass', 'secrets.json', '.htpasswd',
  ];
  if (DEFAULT_DENY.includes(base)) return true;
  if (/^\.env($|\.)/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)) return true;
  const DENY_DIRS = ['/node_modules/', '/.git/', '/.ssh/', '/.aws/', '/.gnupg/', '/Library/Keychains/', '/.cache/'];
  if (DENY_DIRS.some((d) => `${p}/`.includes(d))) return true;
  return extraGlobs.some((g) => globMatch(p, g));
}

/** Supports the `*`, `?` and `**` wildcards users actually type. */
export function globMatch(path: string, glob: string): boolean {
  if (glob.trim() === '') return false;
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*') +
      '$',
  );
  return re.test(path);
}
