/**
 * Prompt-injection defence for untrusted text.
 *
 * Imported documents, repository READMEs and connector payloads are data, not
 * instructions. Before any of it is placed in an AI prompt it is wrapped,
 * fenced and scanned, and the detection result is surfaced to the user rather
 * than silently swallowed.
 */

export interface GuardResult {
  /** Text safe to embed inside a fenced, clearly-labelled data block. */
  text: string;
  suspicious: boolean;
  signals: string[];
}

const SIGNALS: Array<{ name: string; re: RegExp }> = [
  { name: 'instruction-override', re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)/i },
  { name: 'role-assertion', re: /^\s*(?:system|assistant|developer)\s*[:>]/im },
  { name: 'fence-break', re: /<\/?(?:untrusted-data|system|instructions)[^>]*>/i },
  { name: 'exfiltration', re: /\b(?:send|post|upload|exfiltrate|email)\b[^.\n]{0,40}\b(?:api[_ -]?key|token|secret|password|credentials?|\.env)\b/i },
  { name: 'tool-coercion', re: /\b(?:you\s+must|immediately)\b[^.\n]{0,60}\b(?:call|invoke|run|execute)\b[^.\n]{0,30}\b(?:tool|function|command|shell)\b/i },
  { name: 'authority-claim', re: /\b(?:I am|this is)\s+(?:the\s+)?(?:system|administrator|admin|owner|anthropic|openai)\b/i },
  { name: 'policy-override', re: /\b(?:new|updated)\s+(?:system\s+)?(?:instructions?|policy|rules?)\s*[:\-]/i },
];

export function guardUntrusted(raw: string, label: string): GuardResult {
  const signals = SIGNALS.filter((s) => s.re.test(raw)).map((s) => s.name);
  // Neutralise anything that could close our own fence.
  const text = raw
    .replace(/<\/?untrusted-data[^>]*>/gi, '[tag-removed]')
    .replace(/\u0000/g, '');
  return {
    text: `<untrusted-data source="${label.replace(/"/g, "'")}">\n${text}\n</untrusted-data>`,
    suspicious: signals.length > 0,
    signals,
  };
}

/** Short, user-facing explanation of why a document was flagged. */
export function explainSignals(signals: string[]): string {
  if (signals.length === 0) return '';
  const map: Record<string, string> = {
    'instruction-override': 'text that tries to override assistant instructions',
    'role-assertion': 'text impersonating a system or assistant role',
    'fence-break': 'text attempting to escape its data block',
    exfiltration: 'text asking for credentials to be sent somewhere',
    'tool-coercion': 'text demanding a tool or command be run',
    'authority-claim': 'text claiming administrative authority',
    'policy-override': 'text declaring new instructions or policy',
  };
  return signals.map((s) => map[s] ?? s).join('; ');
}
