// Network-contact upserts shared by the bulk CSV path (import_linkedin) and the chat path
// (add_contacts). Contacts live in `linkedin_connections` — the same table find_warm_intros
// and find_founders read — so anything added here is immediately discoverable there.
//
// Company names are resolved through the SAME fuzzy alias/normalization as everywhere else
// (core/jobs.ts upsertCompany: strip Inc/LLC/PBC/Ltd/Corp/…, lowercase, trim) so a contact
// at "ANTHROPIC PBC" lands on the same company row as a job scraped as "Anthropic".

import { randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../db.js';
import { upsertCompany, findCompanyByName } from './jobs.js';

// Title → role flags. Same families used by import_linkedin so both paths classify identically.
export interface ClassifyFlags { is_recruiter: number; is_engineering: number; is_leadership: number; }
export function classifyTitle(title: string | undefined | null): ClassifyFlags {
  const t = (title ?? '').toLowerCase();
  return {
    is_recruiter:   /(recruit|talent|sourcer|head of talent)/i.test(t) ? 1 : 0,
    is_engineering: /(engineer|developer|swe|sre|ml|data|backend|frontend|fullstack|platform)/i.test(t) ? 1 : 0,
    is_leadership:  /(chief|founder|ceo|cto|cpo|cmo|vp|director|head of|principal)/i.test(t) ? 1 : 0,
  };
}

export interface ContactInput {
  full_name?:      string;
  company?:        string;
  position?:       string;   // a.k.a. title (the tool accepts both and maps title→position)
  linkedin_url?:   string;
  email?:          string;
  notes?:          string;
  is_recruiter?:   boolean;
  is_engineering?: boolean;
  is_leadership?:  boolean;
}

export interface ContactResult {
  full_name:        string;
  action:           'inserted' | 'updated' | 'skipped';
  resolved_company: string | null;   // canonical company name the contact resolved to
  unresolved:       string[];         // gaps the chat may want to fill (no linkedin_url, company unmatched, …)
  reason?:          string;           // why a row was skipped
}

export interface AddContactsSummary {
  total:    number;
  inserted: number;
  updated:  number;
  skipped:  number;
  results:  ContactResult[];
}

const trimOrNull = (s: string | undefined | null): string | null => {
  const v = (s ?? '').trim();
  return v ? v : null;
};

/**
 * Upsert 1..N contacts into linkedin_connections in ONE serialized write transaction.
 * Per contact: match on linkedin_url if present, else full_name + resolved company; insert
 * if new, merge (COALESCE — never null an omitted field) if matched. Invalid rows (no
 * full_name) are skipped + reported, never failing the batch.
 */
export async function addContacts(contacts: ContactInput[]): Promise<AddContactsSummary> {
  return runInWriteLock(() => {
    const db = getDb();
    const tx = db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT INTO linkedin_connections (
          id, first_name, last_name, full_name, email, linkedin_url,
          company_id, company_raw, position, notes,
          is_recruiter, is_engineering, is_leadership
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Merge-don't-clobber: every optional field is COALESCE'd so omitting it keeps the
      // stored value. full_name is always provided (it's the required key).
      const updateStmt = db.prepare(`
        UPDATE linkedin_connections SET
          full_name      = ?,
          first_name     = COALESCE(NULLIF(?, ''), first_name),
          last_name      = COALESCE(NULLIF(?, ''), last_name),
          email          = COALESCE(?, email),
          linkedin_url   = COALESCE(?, linkedin_url),
          company_id     = COALESCE(?, company_id),
          company_raw    = COALESCE(?, company_raw),
          position       = COALESCE(NULLIF(?, ''), position),
          notes          = COALESCE(?, notes),
          is_recruiter   = COALESCE(?, is_recruiter),
          is_engineering = COALESCE(?, is_engineering),
          is_leadership  = COALESCE(?, is_leadership),
          updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const byUrl  = db.prepare(`SELECT id FROM linkedin_connections WHERE linkedin_url = ?`);
      const byName = db.prepare(`SELECT id FROM linkedin_connections WHERE LOWER(full_name) = LOWER(?) AND company_id IS ?`);
      const compName = db.prepare(`SELECT name FROM companies WHERE id = ?`);

      const results: ContactResult[] = [];
      let inserted = 0, updated = 0, skipped = 0;

      for (const c of contacts) {
        const full_name = (c.full_name ?? '').trim();
        if (!full_name) {
          skipped++;
          results.push({ full_name: (c.full_name ?? '').trim(), action: 'skipped', resolved_company: null,
            unresolved: ['full_name'], reason: 'missing full_name (required) — row skipped' });
          continue;
        }

        const position     = trimOrNull(c.position);
        const linkedin_url = trimOrNull(c.linkedin_url);
        const email        = trimOrNull(c.email);
        const notes        = trimOrNull(c.notes);
        const companyRaw   = trimOrNull(c.company);
        const unresolved: string[] = [];

        // Resolve the company through the shared fuzzy matcher.
        let company_id: string | null = null;
        let resolved_company: string | null = null;
        if (companyRaw) {
          const preexisting = findCompanyByName(companyRaw);   // before upsert: was it already known?
          try { company_id = upsertCompany(companyRaw, { source: 'manual' }); } catch { /* ignore */ }
          if (company_id) {
            resolved_company = (compName.get(company_id) as { name: string } | undefined)?.name ?? companyRaw;
            if (!preexisting) unresolved.push(`company "${companyRaw}" did not match a known company row (a new one was created)`);
          } else {
            unresolved.push(`company "${companyRaw}" could not be resolved`);
          }
        } else {
          unresolved.push('no company');
        }
        if (!linkedin_url) unresolved.push('no linkedin_url');
        if (!email)        unresolved.push('no email');

        // Classification: caller-provided flag wins; else infer from title (only when a title
        // was given — no title means "no signal", so on update we keep the existing flag).
        const inf = classifyTitle(position);
        const hasTitle = !!position;
        const flag = (provided: boolean | undefined, inferred: number): number | null =>
          provided !== undefined ? (provided ? 1 : 0) : (hasTitle ? inferred : null);
        const is_recruiter   = flag(c.is_recruiter,   inf.is_recruiter);
        const is_engineering = flag(c.is_engineering, inf.is_engineering);
        const is_leadership  = flag(c.is_leadership,  inf.is_leadership);

        const parts = full_name.split(/\s+/);
        const first = parts[0] ?? '';
        const last  = parts.slice(1).join(' ');

        // Match: linkedin_url first (unique), else full_name + resolved company.
        const hit = (linkedin_url
          ? byUrl.get(linkedin_url)
          : byName.get(full_name, company_id)) as { id: string } | undefined;

        if (hit) {
          updateStmt.run(full_name, first, last, email, linkedin_url, company_id, companyRaw,
                         position, notes, is_recruiter, is_engineering, is_leadership, hit.id);
          updated++;
          results.push({ full_name, action: 'updated', resolved_company, unresolved });
        } else {
          insertStmt.run(randomUUID(), first, last, full_name, email, linkedin_url, company_id, companyRaw,
                         position, notes, is_recruiter ?? 0, is_engineering ?? 0, is_leadership ?? 0);
          inserted++;
          results.push({ full_name, action: 'inserted', resolved_company, unresolved });
        }
      }
      return { total: contacts.length, inserted, updated, skipped, results };
    });
    return tx();
  });
}
