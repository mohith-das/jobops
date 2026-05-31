// Content-hash for cross-source job dedup (study guide §3.2.5).
// Hashes a normalized triple — (company, title, location) — lowercased and stripped of
// whitespace runs so the same role at the same company on Greenhouse + Workday collapses
// to the same hash even when the URLs differ.
import { createHash } from 'node:crypto';

export function contentHash(parts: { company: string; title: string; location?: string | null }): string {
  const norm = (s: string | null | undefined) =>
    (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const blob = [norm(parts.company), norm(parts.title), norm(parts.location)].join('|');
  return createHash('sha256').update(blob, 'utf-8').digest('hex');
}
