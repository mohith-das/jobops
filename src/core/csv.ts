// Minimal CSV parser — RFC 4180 with quoted fields, embedded commas, CRLF, escaped quotes.
// We avoid a dep here because LinkedIn's Connections.csv export and the DOL OFLC CSVs we
// ingest are both well-formed.
//
// Also exports helpers shared by every CSV importer:
//   - pickHeader(row)   : returns a `get(row, ...aliases)` closure that's O(1) per row
//                          (vs O(headers) per lookup the naive way)
//   - parseMaybeNumber  : strips $/, returns null when not finite
//   - expandUserPath    : ~  → $HOME, then absolutize against cwd

import { resolve } from 'node:path';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] && r[0].trim().length));
}

export function rowsToObjects(rows: string[][]): Array<Record<string, string>> {
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = (r[i] ?? '').trim();
    return o;
  });
}

// Header lookup with alias support. Build ONCE from the header row, then call the
// returned getter per data row — O(1) per lookup vs O(headers) for the naive approach.
// 200k DOL rows × 20 lookups stops being a hot spot.
export function pickHeader(header: string[]): (row: string[], ...aliases: string[]) => string {
  const index = new Map<string, number>();
  for (let i = 0; i < header.length; i++) index.set(header[i].toLowerCase().trim(), i);
  return (row: string[], ...aliases: string[]): string => {
    for (const a of aliases) {
      const i = index.get(a.toLowerCase().trim());
      if (i !== undefined) return (row[i] ?? '').trim();
    }
    return '';
  };
}

export function parseMaybeNumber(s: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function expandUserPath(p: string): string {
  return resolve(p.startsWith('~') ? p.replace('~', process.env.HOME ?? '') : p);
}

// Try to skip LinkedIn's leading preamble.
export function findLinkedinHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i];
    if (!r) continue;
    const lower = r.map(c => c.toLowerCase());
    if (lower.includes('first name') && lower.includes('last name') && lower.some(c => c.includes('connect'))) return i;
  }
  return 0;
}
