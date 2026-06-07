// Company-name normalization + canonicalization for fuzzy matching.
//
// The problem: the same employer shows up under legal-name variants across data
// sources — "ANTHROPIC PBC" (DOL H1B filings), "Anthropic" (a LinkedIn connection),
// "Anthropic, Inc." (a scraped JD). Exact / LIKE matching splits these into separate
// `companies` rows, which breaks the company_id joins that warm-intro and visa-signal
// lookups depend on.
//
// Two functions, two jobs:
//   normalizeCompanyName  — the light touch: lowercase + collapse whitespace. This is
//                           the value stored in companies.name_normalized (UNIQUE) and
//                           is what the display name maps to 1:1.
//   canonicalCompanyName  — the fuzzy key: strips legal-entity suffixes (Inc, LLC, PBC,
//                           Ltd, Corp, Co, GmbH, …), drops punctuation, lowercases,
//                           collapses whitespace. Two names that differ only by a legal
//                           suffix or punctuation produce the SAME canonical key, so the
//                           upsert path can collapse them onto one company row (recorded
//                           via the company_aliases table).

// Trailing legal-entity designators we strip. Kept to actual entity types — NOT
// descriptive words like "labs" / "group" / "technologies", which would over-collapse
// genuinely distinct companies.
const LEGAL_SUFFIXES = new Set<string>([
  'inc', 'incorporated', 'llc', 'pbc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'ag', 'sa', 'plc', 'llp', 'lp', 'pte', 'pvt', 'bv',
  'nv', 'oy', 'oyj', 'ab', 'srl', 'spa', 'kk', 'aps', 'as', 'sas', 'sl', 'kg',
  'ug', 'sro', 'doo', 'sarl', 'cv', 'aps',
]);

/** Light normalization: lowercase, collapse internal whitespace, trim. */
export function normalizeCompanyName(name: string): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fuzzy match key. Lowercase → punctuation to spaces → collapse whitespace →
 * drop a leading "the" → iteratively strip trailing legal-entity suffix tokens.
 * Returns '' for empty/garbage input. Never strips the only remaining token (a
 * company literally named "Co" stays "co").
 */
export function canonicalCompanyName(name: string): string {
  if (!name) return '';
  // Periods inside acronyms ("L.L.C.", "S.A.") → glue letters so they tokenize as one
  // word, then everything non-alphanumeric becomes a space.
  const s = name
    .toLowerCase()
    .replace(/([a-z])\.([a-z])\./g, '$1$2')   // l.l.c. → llc.
    .replace(/([a-z])\.([a-z])\b/g, '$1$2')   // s.a    → sa
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  let tokens = s.split(' ');
  if (tokens.length > 1 && tokens[0] === 'the') tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
}
