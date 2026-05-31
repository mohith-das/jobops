// Loads cv.md + config/profile.yml + portals.yml from the configured project root.
// Seeds career_packet table with an active row on first run.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { getDb } from '../db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Profile {
  candidate: {
    full_name?:    string;
    email?:        string;
    phone?:        string;
    location?:     string;
    linkedin?:     string;
    portfolio_url?:string;
    github?:       string;
    twitter?:      string;
  };
  target_roles?: unknown;
  narrative?:    unknown;
  compensation?: unknown;
  location?:     unknown;
  cv?:           { output_format?: 'html' | 'latex' };
  language?:     { modes_dir?: string };
}

export interface ProjectFiles {
  cvMd:        string | null;   // raw markdown
  profile:     Profile | null;
  portalsYml:  string | null;   // raw text; we parse only when scan_portals needs it
}

// ── Loaders ──────────────────────────────────────────────────────────────────

export function pathInProject(...parts: string[]): string {
  return resolve(config.projectRoot, ...parts);
}

export function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

export function loadProjectFiles(): ProjectFiles {
  const cvMd       = readIfExists(pathInProject('cv.md'));
  const profileRaw = readIfExists(pathInProject('config', 'profile.yml'));
  const portalsYml = readIfExists(pathInProject('portals.yml'));

  let profile: Profile | null = null;
  if (profileRaw) {
    const parsed = yaml.load(profileRaw);
    if (parsed && typeof parsed === 'object') {
      profile = parsed as Profile;
    }
  }
  return { cvMd, profile, portalsYml };
}

// ── Career packet seeding ─────────────────────────────────────────────────────

/**
 * On first startup, ensure exactly one `is_active = 1` row exists in `career_packet`.
 * If none exists, seed it from `modes/career_packet.md` (the markdown source of truth)
 * combined with the candidate identity block from `config/profile.yml`. The cv.md hash
 * is stored so we can detect drift later (`cv-sync-check` equivalent in milestone 2).
 */
export function ensureActiveCareerPacket(): { version: number; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare('SELECT version FROM career_packet WHERE is_active = 1')
    .get() as { version: number } | undefined;
  if (existing) return { version: existing.version, created: false };

  const packetTemplatePath = resolve(config.modesDir, 'career_packet.md');
  const packetBody = readIfExists(packetTemplatePath) ?? '# Career Packet (empty)';
  const { cvMd, profile } = loadProjectFiles();
  const identityBlock = renderIdentityBlock(profile);
  const content = packetBody.replace(
    /## 1\. Identity[\s\S]*?(?=^## )/m,
    `## 1. Identity\n\n${identityBlock}\n\n`,
  );
  const sourceHash = cvMd ? sha256(cvMd) : null;

  db.prepare(`
    INSERT INTO career_packet (id, version, content, taglines, is_active, source_cv_hash, notes)
    VALUES (?, 1, ?, NULL, 1, ?, 'seeded on first run')
  `).run(randomUUID(), content, sourceHash);

  return { version: 1, created: true };
}

export function getActiveCareerPacket(): {
  id: string; version: number; content: string; source_cv_hash: string | null;
} | null {
  const row = getDb()
    .prepare(`SELECT id, version, content, source_cv_hash FROM career_packet WHERE is_active = 1`)
    .get() as any;
  return row ?? null;
}

function renderIdentityBlock(profile: Profile | null): string {
  if (!profile?.candidate) return '_No `config/profile.yml` found — populate it to enrich._';
  const c = profile.candidate;
  const lines: string[] = [];
  if (c.full_name)    lines.push(`- **Name:** ${c.full_name}`);
  if (c.email)        lines.push(`- **Email:** ${c.email}`);
  if (c.phone)        lines.push(`- **Phone:** ${c.phone}`);
  if (c.location)     lines.push(`- **Location:** ${c.location}`);
  if (c.linkedin)     lines.push(`- **LinkedIn:** ${c.linkedin}`);
  if (c.portfolio_url)lines.push(`- **Portfolio:** ${c.portfolio_url}`);
  if (c.github)       lines.push(`- **GitHub:** ${c.github}`);
  if (c.twitter)      lines.push(`- **Twitter:** ${c.twitter}`);
  return lines.length ? lines.join('\n') : '_Profile present but no candidate fields filled._';
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
