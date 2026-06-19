// Pluggable LLM module.
//
// Provider picked by env (`JOBOPS_LLM_PROVIDER`):
//   - gemini   → Google AI Studio free tier (default). `GEMINI_API_KEY` required.
//   - deepseek → DeepSeek chat API (OpenAI-compatible). `DEEPSEEK_API_KEY` required.
//   - none     → throws on call. Default behaviour when neither key is set.
//
// Every call records a row in `llm_calls` (telemetry → cost_estimate()) and runs through
// `parseJsonStrict` when `responseFormat: 'json_object'` is requested. Strict-JSON parse
// failures are visible (parse_ok = 0, parse_error populated) — never silent zeros.

import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { getDb } from '../db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOpts {
  model?:         string;
  temperature?:   number;
  responseFormat?: 'text' | 'json_object';
  maxTokens?:     number;
}

export interface LLMResult {
  provider:    string;
  model:       string;
  text:        string;        // raw model output (already stripped of trailing fence)
  parsed?:     unknown;       // populated when responseFormat='json_object' AND parse_ok
  parseOk:     boolean;
  parseError?: string;
  durationMs:  number;
  inputChars:  number;
  outputChars: number;
}

export interface LLMProvider {
  name:         string;
  defaultModel: string;
  chat(messages: LLMMessage[], opts?: LLMOpts): Promise<LLMResult>;
}

// ── Provider selection ───────────────────────────────────────────────────────

let _cached: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (_cached) return _cached;
  const p = config.llmProvider?.toLowerCase();
  if (p === 'gemini'   && process.env.GEMINI_API_KEY)   _cached = new GeminiProvider();
  else if (p === 'deepseek' && process.env.DEEPSEEK_API_KEY) _cached = new DeepSeekProvider();
  else _cached = new NoneProvider();
  return _cached;
}

export function resetLLMCache(): void { _cached = null; }

export function llmAvailable(): boolean { return getLLM().name !== 'none'; }

// ── Helper: strict JSON parse with PARSE_ERROR fallback ──────────────────────

export function parseJsonStrict<T = unknown>(text: string):
  { ok: true; data: T } | { ok: false; error: string; raw: string } {
  try {
    // Strip leading/trailing code fences and BOM/whitespace, plus any leading prose
    // before the first '{' — LLMs sometimes preface JSON with "Sure, here's...".
    let cleaned = text.replace(/^﻿/, '').trim();
    cleaned = cleaned.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);
    return { ok: true, data: JSON.parse(cleaned) as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'JSON parse failed', raw: text.slice(0, 800) };
  }
}

// Lenient JSON parser — returns `fallback` on failure. Use this for opportunistic reads
// (e.g. score_detail history) where missing structure is normal. For LLM contracts use
// parseJsonStrict so failures stay visible.
export function safeJson<T = any>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

// ── Wrapper: run + telemetry ─────────────────────────────────────────────────

export interface ChatLogged extends LLMResult { id: string; }

export async function chatLogged(tool: string, messages: LLMMessage[],
                                  opts: LLMOpts & { jobId?: string } = {}): Promise<ChatLogged> {
  const provider = getLLM();
  const t0 = Date.now();
  const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
  let result: LLMResult;
  let errored = false;
  try {
    result = await provider.chat(messages, opts);
    // Strict-JSON parsing lives here (not in each provider) so adding a provider stays
    // 1 file. Providers return raw text + parseOk=true; we apply the contract.
    if (opts.responseFormat === 'json_object' && !('parsed' in result)) {
      const p = parseJsonStrict(result.text);
      if (p.ok) (result as any).parsed = p.data;
      else { result.parseOk = false; result.parseError = p.error; }
    }
  } catch (e: any) {
    errored = true;
    result = {
      provider:    provider.name,
      model:       opts.model ?? provider.defaultModel,
      text:        '',
      parseOk:     false,
      parseError:  `provider_error: ${e?.message ?? String(e)}`,
      durationMs:  Date.now() - t0,
      inputChars,
      outputChars: 0,
    };
  }
  const id = randomUUID();
  try {
    getDb().prepare(`
      INSERT INTO llm_calls
        (id, tool, provider, model, job_id, input_chars, output_chars,
         parse_ok, parse_error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tool, result.provider, result.model, opts.jobId ?? null,
      result.inputChars, result.outputChars,
      result.parseOk ? 1 : 0, result.parseError ?? null,
      result.durationMs,
    );
  } catch {
    // Telemetry must never break the caller.
  }
  if (errored) throw new Error(result.parseError);
  return { ...result, id };
}

// ── Providers ────────────────────────────────────────────────────────────────

class NoneProvider implements LLMProvider {
  name = 'none';
  defaultModel = 'none';
  async chat(): Promise<LLMResult> {
    throw new Error(
      'No LLM provider configured. Set JOBOPS_LLM_PROVIDER=gemini (with GEMINI_API_KEY) ' +
      'or =deepseek (with DEEPSEEK_API_KEY). The default chat-mode tools do not need this — ' +
      'only api/batch paths do.',
    );
  }
}

class GeminiProvider implements LLMProvider {
  name = 'gemini';
  defaultModel = config.llmModel || 'gemini-2.5-flash';

  async chat(messages: LLMMessage[], opts: LLMOpts = {}): Promise<LLMResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    const model = opts.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    // Map our role/content shape to Gemini's. System → systemInstruction; user/assistant → contents.
    const systems = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
                   parts: [{ text: m.content }] }));

    const body: any = {
      contents,
      generationConfig: {
        temperature:      opts.temperature ?? 0.2,
        maxOutputTokens:  opts.maxTokens ?? 4096,
      },
    };
    if (systems) body.systemInstruction = { parts: [{ text: systems }] };
    if (opts.responseFormat === 'json_object') {
      body.generationConfig.responseMimeType = 'application/json';
    }

    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
    const t0 = Date.now();
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`gemini HTTP ${res.status}: ${truncate(JSON.stringify(json), 400)}`);
    }
    const text: string = json?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text ?? '').join('') ?? '';
    return {
      provider:    this.name,
      model,
      text,
      parseOk:     true,
      durationMs:  Date.now() - t0,
      inputChars,
      outputChars: text.length,
    };
  }
}

class DeepSeekProvider implements LLMProvider {
  name = 'deepseek';
  defaultModel = config.llmModel || 'deepseek-chat';

  async chat(messages: LLMMessage[], opts: LLMOpts = {}): Promise<LLMResult> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY missing');
    const model = opts.model ?? this.defaultModel;
    const body: any = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.2,
      max_tokens:  opts.maxTokens ?? 4096,
    };
    if (opts.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
    const t0 = Date.now();
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method:  'POST',
      headers: { 'content-type': 'application/json',
                 'authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`deepseek HTTP ${res.status}: ${truncate(JSON.stringify(json), 400)}`);
    }
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    return {
      provider:    this.name,
      model,
      text,
      parseOk:     true,
      durationMs:  Date.now() - t0,
      inputChars,
      outputChars: text.length,
    };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// ── Cost table — used by cost_estimate() ─────────────────────────────────────
// Prices in USD per 1M tokens; we approximate tokens as chars/4 (good-enough for a UI estimate).
// Update as providers change.
export const COST_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash':     { input: 0.075, output: 0.30  },  // free tier; cited for paid fallback
  'gemini-2.5-pro':       { input: 1.25,  output: 5.00  },
  'deepseek-chat':        { input: 0.27,  output: 1.10  },
};

export function estimateCostUsd(model: string, inputChars: number, outputChars: number): number {
  const rate = COST_TABLE[model] ?? { input: 0, output: 0 };
  const inputTokens  = inputChars  / 4;
  const outputTokens = outputChars / 4;
  return (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
}
