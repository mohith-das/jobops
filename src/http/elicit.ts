// Out-of-band secret capture for URL-mode elicitation (MCP 2025-11-25).
//
// Some inputs are sensitive and should NOT travel through the MCP client / chat transcript:
// a LinkedIn export path, an API key, a credential. URL-mode elicitation sends the user to
// a URL to provide the value directly. Here, that URL is hosted by THIS server: the user
// types the secret into a tiny local form which POSTs straight back to us, so the value
// never passes through the MCP client.
//
// A capture is a one-time, short-TTL pending entry keyed by an unguessable id. The tool
// awaits `capture.promise`, which resolves when the form is submitted (or rejects on TTL).

import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';

interface PendingCapture {
  id:        string;
  label:     string;
  field:     string;
  createdAt: number;
  done:      boolean;
  resolve:   (value: string) => void;
  reject:    (err: Error) => void;
  timer:     ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCapture>();

export interface CaptureHandle {
  id:      string;
  url:     string;
  promise: Promise<string>;
}

/** Register a pending capture and return its id, URL, and a promise that resolves on submit. */
export function createCapture(opts: { label: string; field?: string; ttlMs?: number }): CaptureHandle {
  const id = randomUUID();
  const ttl = opts.ttlMs ?? 5 * 60_000;
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  // Attach a no-op handler so a TTL rejection never surfaces as an unhandledRejection if
  // the caller hasn't awaited yet. The caller's own `await` still observes the rejection
  // independently (a promise can have many handlers).
  promise.catch(() => {});
  const timer = setTimeout(() => {
    const p = pending.get(id);
    if (p && !p.done) { p.done = true; pending.delete(id); reject(new Error('capture timed out (no submission within TTL)')); }
  }, ttl);
  // Don't keep the event loop alive solely for a pending capture.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  pending.set(id, { id, label: opts.label, field: opts.field ?? 'value', createdAt: Date.now(), done: false, resolve, reject, timer });
  return { id, url: `${config.publicBaseUrl}/elicit/${id}`, promise };
}

/** Programmatic submit (also used by tests). Returns false if the id is unknown/expired. */
export function submitCapture(id: string, value: string): boolean {
  const p = pending.get(id);
  if (!p || p.done) return false;
  p.done = true;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
  return true;
}

export function hasCapture(id: string): boolean {
  const p = pending.get(id);
  return !!p && !p.done;
}

/**
 * Mount the capture routes. Deliberately mounted BEFORE the bearer-auth guard so the user
 * can complete the flow in a browser without setting an Authorization header; the one-time
 * unguessable id is the capability. Values are held in memory only and never logged.
 */
export function mountElicit(app: Express, base = '/elicit'): void {
  app.get(`${base}/:id`, (req: Request, res: Response) => {
    const p = pending.get(req.params.id);
    if (!p || p.done) { res.status(404).type('html').send(notFoundPage()); return; }
    res.type('html').send(formPage(p));
  });

  app.post(`${base}/:id`, (req: Request, res: Response) => {
    const id = req.params.id;
    const value = String((req.body && (req.body.value ?? req.body[pending.get(id)?.field ?? 'value'])) ?? '').trim();
    if (!value) { res.status(400).type('html').send(resultPage('Missing value — go back and try again.', false)); return; }
    const ok = submitCapture(id, value);
    res.status(ok ? 200 : 404).type('html').send(
      ok ? resultPage('Received. You can close this tab and return to your chat.', true)
         : resultPage('This capture link has expired or was already used.', false),
    );
  });
}

// ── Minimal HTML (no deps; intentionally plain) ───────────────────────────────

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}`
    + `input{width:100%;padding:.6rem;font:inherit;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}`
    + `button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}`
    + `.note{color:#555;font-size:.9em}</style></head><body>${body}</body></html>`;
}

function formPage(p: PendingCapture): string {
  return shell('Provide a value securely', `
    <h2>${esc(p.label)}</h2>
    <p class="note">This value is sent directly to your local job_ops-mcp server and never passes through your chat client.</p>
    <form method="post">
      <input name="value" autofocus autocomplete="off" placeholder="Enter the value…" />
      <button type="submit">Submit securely</button>
    </form>`);
}

function resultPage(msg: string, ok: boolean): string {
  return shell(ok ? 'Done' : 'Error', `<h2>${ok ? '✓' : '✗'} ${esc(msg)}</h2>`);
}

function notFoundPage(): string {
  return shell('Not found', `<h2>This capture link is invalid, expired, or already used.</h2>`);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
