// Outreach safety rails. Distilled from modes/outreach_tone.md.
//
// We treat these as HARD invariants — any draft (chat- or api-mode) is validated by
// `validateOutreach()` before persisting. Failures get surfaced to the chat so it can
// regenerate; we never silently strip-and-save.

export interface OutreachLimits {
  maxChars: number;
  type:     'warm' | 'founder' | 'followup' | 'reply' | 'generic';
}

const LIMITS: Record<string, OutreachLimits> = {
  warm:     { maxChars: 600, type: 'warm' },
  founder:  { maxChars: 300, type: 'founder' },
  followup: { maxChars: 300, type: 'followup' },
  reply:    { maxChars: 800, type: 'reply' },
  generic:  { maxChars: 600, type: 'generic' },
};

const REFER_PATTERNS = [
  /refer\s+me\b/i,
  /can you (?:put|forward|pass)\s+my\s+(?:resume|cv)/i,
  /could you (?:put|forward|pass)\s+my\s+(?:resume|cv)/i,
  /put\s+(?:in\s+)?a\s+good\s+word\b/i,
  /\bget\s+me\s+(?:an?\s+)?(?:interview|referral)\b/i,
];

const VISA_PATTERNS = [
  /\bH[\s-]?1B\b/i,
  /\bOPT\b/,
  /\bSTEM\s*OPT\b/i,
  /\bEAD\b/,
  /\bvisa\b/i,
  /\bwork\s+authorization\b/i,
  /\bwork\s+permit\b/i,
  /\bsponsor(?:ship|s)?\b/i,
  /\bgreen\s+card\b/i,
  /\bcitizen(?:ship)?\b/i,
];

const CLICHE_FORBIDDEN = [
  /\bI hope this (?:finds you well|email finds you well)\b/i,
  /\bI'?d love to pick your brain\b/i,
];

export interface ValidationIssue {
  rule: string;
  hit:  string;
}

export interface ValidationResult {
  ok:        boolean;
  message_len: number;
  limit:     number;
  type:      OutreachLimits['type'];
  issues:    ValidationIssue[];
}

export function getOutreachLimits(type: string): OutreachLimits {
  return LIMITS[type] ?? LIMITS.generic;
}

// All forbidden-pattern groups in one table so adding a new rail is one entry.
const RAIL_GROUPS: Array<{ rule: string; patterns: RegExp[] }> = [
  { rule: 'no_visa_mentions', patterns: VISA_PATTERNS    },  // loudest rail first
  { rule: 'no_refer_me',      patterns: REFER_PATTERNS   },
  { rule: 'no_cliches',       patterns: CLICHE_FORBIDDEN },
];

export function validateOutreach(message: string, type: keyof typeof LIMITS): ValidationResult {
  const limits = LIMITS[type] ?? LIMITS.generic;
  const issues: ValidationIssue[] = [];
  const len = (message ?? '').length;
  if (len === 0) issues.push({ rule: 'non_empty', hit: 'message is empty' });
  if (len > limits.maxChars) issues.push({ rule: 'char_cap', hit: `${len} chars > ${limits.maxChars} cap` });
  for (const group of RAIL_GROUPS) {
    for (const re of group.patterns) {
      const m = message.match(re);
      if (m) issues.push({ rule: group.rule, hit: m[0] });
    }
  }
  if (/!/.test(message)) issues.push({ rule: 'no_exclamation_marks', hit: '!' });
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(message)) {
    issues.push({ rule: 'no_emojis', hit: 'emoji codepoint present' });
  }
  return { ok: issues.length === 0, message_len: len, limit: limits.maxChars, type: limits.type, issues };
}

// For PDFs / reports / cover letters — same visa rail.
export function scanForVisaLeakage(text: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const re of VISA_PATTERNS) {
    const m = text.match(re); if (m) out.push({ rule: 'no_visa_mentions', hit: m[0] });
  }
  return out;
}
