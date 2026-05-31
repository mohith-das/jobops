// Scan engine — reads portals.yml, fans out across providers, upserts via upsertJob
// (which does cross-source content-hash dedupe). Records a run summary in scan_runs.

import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { upsertJob } from './jobs.js';
import { loadProjectFiles } from './profile.js';
import { closeProviderBrowser, makeProviderCtx, PROVIDERS, resolveProvider } from './providers/index.js';
import type { RawJob, TrackedCompanyEntry } from './providers/types.js';

export interface ScanFilters {
  sources?:        string[];          // provider ids to allow; empty = all
  companies?:      string[];          // substring match on name; empty = all
  title_positive?: string[];          // case-insensitive substrings — must match ANY
  title_negative?: string[];          // must NOT match ANY
  location_allow?: string[];
  location_block?: string[];
}

export interface ScanResult {
  run_id:        string;
  triggered_by:  string;
  started_at:    string;
  finished_at:   string;
  sources:       string[];
  companies_scanned: number;
  jobs_found:    number;
  jobs_new:      number;
  jobs_dupes:    number;
  top_new:       Array<{ company: string; title: string; url: string; job_id: string }>;
  errors:        Array<{ company: string; error: string }>;
}

// ── portals.yml parser ───────────────────────────────────────────────────────

function buildTitleFilter(yml: any, override: ScanFilters): (t: string) => boolean {
  const pos = (override.title_positive ?? yml?.title_filter?.positive ?? []).map((s: string) => s.toLowerCase());
  const neg = (override.title_negative ?? yml?.title_filter?.negative ?? []).map((s: string) => s.toLowerCase());
  return (title: string) => {
    const t = (title ?? '').toLowerCase();
    const okPos = pos.length === 0 || pos.some((k: string) => t.includes(k));
    const okNeg = !neg.some((k: string) => t.includes(k));
    return okPos && okNeg;
  };
}

function buildLocationFilter(yml: any, override: ScanFilters): (loc: string) => boolean {
  const allow = (override.location_allow ?? yml?.location_filter?.allow ?? []).map((s: string) => s.toLowerCase());
  const block = (override.location_block ?? yml?.location_filter?.block ?? []).map((s: string) => s.toLowerCase());
  const always = (yml?.location_filter?.always_allow ?? []).map((s: string) => s.toLowerCase());
  return (loc: string) => {
    if (!loc || !loc.trim()) return true;
    const l = loc.toLowerCase();
    if (always.length && always.some((k: string) => l.includes(k))) return true;
    if (block.length  && block.some((k: string)  => l.includes(k))) return false;
    if (!allow.length) return true;
    return allow.some((k: string) => l.includes(k));
  };
}

function readPortalsYml(): { yml: any; companies: TrackedCompanyEntry[] } {
  const { portalsYml } = loadProjectFiles();
  if (!portalsYml) return { yml: null, companies: [] };
  const doc = yaml.load(portalsYml) as any;
  const companies = (Array.isArray(doc?.tracked_companies) ? doc.tracked_companies : [])
    .filter((c: any) => c && typeof c === 'object' && c.enabled !== false && typeof c.name === 'string');
  return { yml: doc, companies };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export async function runScan(filters: ScanFilters = {}, opts: { triggeredBy?: string } = {}): Promise<ScanResult> {
  const runId = randomUUID();
  const started = new Date().toISOString();
  const { yml, companies } = readPortalsYml();
  const passTitle = buildTitleFilter(yml, filters);
  const passLoc   = buildLocationFilter(yml, filters);
  const allowSources = new Set((filters.sources ?? []).map(s => s.toLowerCase()));
  const allowCompanies = (filters.companies ?? []).map(s => s.toLowerCase());

  const ctx = makeProviderCtx();
  const errors: ScanResult['errors'] = [];
  const targets: Array<{ entry: TrackedCompanyEntry; provider: ReturnType<typeof resolveProvider> }> = [];

  for (const entry of companies) {
    if (allowCompanies.length && !allowCompanies.some(k => entry.name.toLowerCase().includes(k))) continue;
    const provider = resolveProvider(entry);
    if (!provider) continue;
    if (allowSources.size && !allowSources.has(provider.id)) continue;
    targets.push({ entry, provider });
  }

  const sourcesUsed = new Set<string>();
  const topNew: ScanResult['top_new'] = [];
  let jobsFound = 0, jobsNew = 0, jobsDupes = 0;
  const polledNames: string[] = [];

  // Fetch in parallel across companies with bounded concurrency. The upserts still
  // serialize through runInWriteLock so SQLite stays happy. Career-ops uses 10; 8 is
  // a safer default given Workday/Google providers are heavier.
  const CONCURRENCY = 8;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const { entry, provider } = targets[idx];
      if (!provider) continue;
      sourcesUsed.add(provider.id);
      let raws: RawJob[] = [];
      try {
        raws = await provider.fetch(entry, ctx);
      } catch (err: any) {
        errors.push({ company: entry.name, error: `${provider.id}: ${err?.message ?? String(err)}` });
        continue;
      }
      for (const j of raws) {
        jobsFound++;
        if (!passTitle(j.title)) continue;
        if (!passLoc(j.location)) continue;
        try {
          const up = await upsertJob({
            source:     provider.id,
            source_url: j.url,
            company_name: j.company || entry.name,
            title:      j.title,
            location:   j.location,
          });
          if (up.created) {
            jobsNew++;
            if (topNew.length < 25) topNew.push({ company: j.company, title: j.title, url: j.url, job_id: up.id });
          } else {
            jobsDupes++;
          }
        } catch (err: any) {
          errors.push({ company: entry.name, error: `upsert: ${err?.message ?? String(err)}` });
        }
      }
      polledNames.push(entry.name);
    }
  });
  await Promise.all(workers);
  // Stamp last_polled_at for all scanned companies in one transaction.
  await stampLastPolledBatch(polledNames);

  const finished = new Date().toISOString();
  await runInWriteLock(() => {
    getDb().prepare(`
      INSERT INTO scan_runs
        (id, started_at, finished_at, sources, companies_n, jobs_found, jobs_new, jobs_dupes, errors_json, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, started, finished,
      JSON.stringify([...sourcesUsed]), targets.length,
      jobsFound, jobsNew, jobsDupes,
      errors.length ? JSON.stringify(errors) : null,
      opts.triggeredBy ?? 'manual',
    );
  });

  return {
    run_id: runId, triggered_by: opts.triggeredBy ?? 'manual',
    started_at: started, finished_at: finished,
    sources: [...sourcesUsed],
    companies_scanned: targets.length,
    jobs_found: jobsFound, jobs_new: jobsNew, jobs_dupes: jobsDupes,
    top_new: topNew, errors,
  };
}

async function stampLastPolledBatch(names: string[]): Promise<void> {
  if (!names.length) return;
  return runInWriteLock(() => {
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE target_companies SET last_polled_at = CURRENT_TIMESTAMP
      WHERE company_id IN (SELECT id FROM companies WHERE name_normalized = ?)
    `);
    const tx = db.transaction((batch: string[]) => {
      for (const n of batch) stmt.run(n.toLowerCase().trim());
    });
    tx(names);
  });
}

export async function shutdownScanResources(): Promise<void> {
  await closeProviderBrowser();
}

export function knownProviderIds(): string[] {
  return [...PROVIDERS.keys()];
}
