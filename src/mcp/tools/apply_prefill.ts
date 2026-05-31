// apply_prefill — Playwright opens the application form, reads visible fields, drafts
// values from career_packet + the tailored materials, takes a screenshot, returns a
// preview. NEVER auto-submits. Brief is explicit: human-in-the-loop everywhere.

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { config } from '../../config.js';
import { getDb } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { getActiveCareerPacket, loadProjectFiles } from '../../core/profile.js';
import { getJobWithCompany } from '../../core/jobs.js';
import { getSharedBrowser } from '../../core/browser.js';
import { safeJson } from '../../core/llm.js';

const PREVIEW_SUBDIR = 'previews';

interface DetectedField {
  selector:    string;
  label:       string;
  type:        string;
  required:    boolean;
  draft_value: string;
  source:      'profile' | 'packet' | 'materials' | 'user_must_provide';
}

export const applyPrefillTool = defineTool({
  name: 'apply_prefill',
  title: 'Apply prefill (preview only — never submits)',
  description:
    'Opens the application URL in Playwright, detects common form fields, drafts values from your profile + ' +
    'tailored materials, and saves a screenshot. Returns a preview + localhost links to the rendered PDFs. ' +
    'NEVER submits, NEVER fills file inputs (resume/cover upload stays manual).',
  inputSchema: {
    job_id: z.string().min(1),
    url:    z.string().url().optional().describe('Override the job source_url (e.g. a different ATS apply URL).'),
  },
  handler: async (args) => {
    const job = getJobWithCompany(args.job_id);
    if (!job) return errResult(`No job ${args.job_id}`);
    const url = args.url ?? job.source_url;
    if (!url || !/^https?:\/\//.test(url)) return errResult(`No usable application URL for job ${args.job_id}`);

    const app = getDb().prepare(`SELECT * FROM applications WHERE job_id = ?`).get(args.job_id) as any;
    const { profile } = loadProjectFiles();
    const packet = getActiveCareerPacket()?.content ?? '';

    // Build a lookup of values we can confidently draft.
    const identity = (profile?.candidate ?? {}) as Record<string, string | undefined>;
    const tailored = safeJson(app?.tailored_bullets, null as any);
    const coverDraft: string | null = app?.cover_letter_draft ?? null;

    try {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(1_500);

      // Detect form inputs. We deliberately stay vanilla: input + textarea + select; skip
      // file/password/hidden; honor <label for="..."> AND aria-label AND placeholder.
      const detected = await page.$$eval(
        'input:not([type="hidden"]):not([type="file"]):not([type="password"]):not([type="submit"]):not([type="button"]), textarea, select',
        (els: any[]) => {
          const lookupLabel = (el: any): string => {
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') as string;
            const id = el.getAttribute('id');
            if (id) {
              const lab = document.querySelector(`label[for="${(window as any).CSS.escape(id)}"]`);
              if (lab) return (lab as HTMLElement).innerText.trim();
            }
            const parentLab = el.closest('label');
            if (parentLab) return (parentLab as HTMLElement).innerText.trim();
            return el.getAttribute('placeholder') || el.getAttribute('name') || '';
          };
          const sel = (el: any): string => {
            const id = el.getAttribute('id');
            if (id) return `#${id}`;
            const name = el.getAttribute('name');
            if (name) return `[name="${name}"]`;
            return el.tagName.toLowerCase();
          };
          return els.slice(0, 60).map((el: any) => ({
            selector: sel(el),
            label:    lookupLabel(el),
            type:     (el.getAttribute('type') || el.tagName).toLowerCase(),
            required: !!el.required || el.getAttribute('aria-required') === 'true',
          }));
        },
      );

      // Screenshot
      mkdirSync(resolve(config.outputDir, PREVIEW_SUBDIR), { recursive: true });
      const shotPath = `${PREVIEW_SUBDIR}/apply-${args.job_id.slice(0, 8)}-${Date.now()}.png`;
      const absShot = resolve(config.outputDir, shotPath);
      await page.screenshot({ path: absShot, fullPage: true });

      const fields: DetectedField[] = detected.map((d: any) => draftValue(d, identity, packet, tailored, coverDraft));

      const previewId = randomUUID();
      const previewJson = {
        preview_id:    previewId,
        job_id:        args.job_id,
        url,
        company:       job.company_name,
        title:         job.title,
        warning:       'preview only — this tool never submits. Upload resume/cover manually using the localhost links below.',
        fields,
        resume_url:    app?.resume_path ? `${config.baseUrl}/files/${app.resume_path}` : null,
        cover_url:     app?.cover_path  ? `${config.baseUrl}/files/${app.cover_path}`  : null,
        screenshot_url: `${config.baseUrl}/files/${shotPath}`,
      };
      // Persist a JSON copy alongside the screenshot for the chat to re-read.
      writeFileSync(absShot.replace(/\.png$/, '.json'), JSON.stringify(previewJson, null, 2), 'utf-8');

      await page.close();
      return okResult(previewJson);
    } catch (e: any) {
      return errResult(`apply_prefill failed: ${e?.message ?? String(e)}`);
    }
    // Shared browser stays alive for the next caller — closed at server shutdown.
  },
});

function draftValue(
  d: { selector: string; label: string; type: string; required: boolean },
  identity: Record<string, string | undefined>,
  _packet: string,
  tailored: any | null,
  coverDraft: string | null,
): DetectedField {
  const key = (d.label + ' ' + d.selector).toLowerCase();
  const profileMatch = (...needles: string[]) => needles.some(n => key.includes(n));
  let value = '';
  let source: DetectedField['source'] = 'user_must_provide';

  if (profileMatch('first name','firstname','given')) { value = (identity.full_name ?? '').split(' ')[0] ?? ''; source = 'profile'; }
  else if (profileMatch('last name','lastname','surname','family')) { value = (identity.full_name ?? '').split(' ').slice(1).join(' ').trim(); source = 'profile'; }
  else if (profileMatch('full name','name')) { value = identity.full_name ?? ''; source = 'profile'; }
  else if (profileMatch('email')) { value = identity.email ?? ''; source = 'profile'; }
  else if (profileMatch('phone','telephone','mobile')) { value = identity.phone ?? ''; source = 'profile'; }
  else if (profileMatch('linkedin')) { value = identity.linkedin ?? ''; source = 'profile'; }
  else if (profileMatch('github')) { value = identity.github ?? ''; source = 'profile'; }
  else if (profileMatch('portfolio','website','personal site','url')) { value = identity.portfolio_url ?? identity.github ?? ''; source = 'profile'; }
  else if (profileMatch('city','location')) { value = identity.location ?? ''; source = 'profile'; }
  else if (profileMatch('cover letter','why','interest','message','tell us')) {
    value = coverDraft ?? ''; source = 'materials';
  } else if (profileMatch('summary','tagline','bio','about')) {
    value = (tailored?.tagline ?? '') || ''; source = 'materials';
  }
  // Honour the visa rail explicitly — refuse to draft anything for these.
  if (profileMatch('visa','sponsor','authoriz','authoris','citizen','work permit','h1b','opt')) {
    value = ''; source = 'user_must_provide';
  }
  return {
    selector: d.selector, label: d.label, type: d.type, required: !!d.required,
    draft_value: value, source,
  };
}

