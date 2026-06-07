// Unified completion path for the api-mode scoring tools (evaluate_job api, batch_evaluate).
//
// Historically there were two rating paths: chat-mode (the connected chat scores, no key)
// and api-mode (a BYO Gemini/DeepSeek key scores server-side). MCP sampling collapses these:
// the server asks the *connected client's* model for the completion — same rubric, same
// strict-JSON contract — so no separate key is needed WHEN the client supports sampling.
// Caveat: sampling is used only if the connected client advertised the `sampling` capability
// in its initialize handshake. Most clients (including Claude Desktop, as of now) do NOT, so
// in practice batch/api scoring usually falls back to the BYO key. See
// modelcontextprotocol.io/clients for current support.
//
// A `Completer` is "give me a strict-JSON completion for these messages". We have two:
//   • samplingCompleter(bridge)  — routes through MCP sampling (client-borne cost);
//   • apiCompleter()             — routes through the BYO-key provider (core/llm.ts).
//
// pickCompleter() chooses sampling when the client advertises it (and MCP_JSA_SAMPLING is
// not disabled), else the BYO-key provider when a key is set, else null (caller surfaces a
// clear "use chat mode or set a key / connect a sampling client" error). Both record a row
// in llm_calls so cost_estimate keeps working — sampling rows are tagged provider='sampling'
// with $0 estimated cost (the client bears it).

import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { getDb } from '../db.js';
import { chatLogged, parseJsonStrict, llmAvailable, type LLMMessage, type ChatLogged } from './llm.js';
import type { ClientBridge } from '../mcp/client_bridge.js';

export interface CompleteOpts {
  temperature?: number;
  maxTokens?:   number;
  jobId?:       string;
}

/** A strict-JSON completion function. Returns a ChatLogged-shaped result (parsed + telemetry). */
export type Completer = (tool: string, messages: LLMMessage[], opts?: CompleteOpts) => Promise<ChatLogged>;

export type CompleterKind = 'sampling' | 'api';

export interface PickedCompleter {
  kind:      CompleterKind;
  completer: Completer;
}

/**
 * Choose the best available completer:
 *   1. sampling — when the connected client advertises it AND MCP_JSA_SAMPLING != false;
 *   2. api      — when a BYO key is configured;
 *   3. null     — neither; caller should fall back to chat mode or instruct the user.
 */
export function pickCompleter(bridge: ClientBridge | undefined): PickedCompleter | null {
  if (config.samplingEnabled && bridge?.canSample()) {
    return { kind: 'sampling', completer: samplingCompleter(bridge) };
  }
  if (llmAvailable()) {
    return { kind: 'api', completer: apiCompleter() };
  }
  return null;
}

/** Sampling-backed completer. Logs to llm_calls as provider='sampling' (client-borne $0). */
export function samplingCompleter(bridge: ClientBridge): Completer {
  return async (tool, messages, opts = {}) => {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined;
    const convo  = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));

    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
    const t0 = Date.now();
    let text = '';
    let model = 'client';
    let parseOk = true;
    let parseError: string | undefined;
    let errored = false;
    try {
      const r = await bridge.sample({
        system, messages: convo,
        maxTokens:   opts.maxTokens ?? 4096,
        temperature: opts.temperature,
      });
      text = r.text;
      model = r.model || 'client';
    } catch (e: any) {
      errored = true;
      parseOk = false;
      parseError = `sampling_error: ${e?.message ?? String(e)}`;
    }

    const result: ChatLogged = {
      id: randomUUID(),
      provider: 'sampling',
      model,
      text,
      parseOk,
      parseError,
      durationMs: Date.now() - t0,
      inputChars,
      outputChars: text.length,
    };

    // Strict-JSON contract — same as the BYO path (core/llm.ts applies it there).
    if (!errored) {
      const p = parseJsonStrict(text);
      if (p.ok) (result as any).parsed = p.data;
      else { result.parseOk = false; result.parseError = p.error; }
    }

    logLlmCall(tool, result, opts.jobId);
    if (errored) throw new Error(parseError);
    return result;
  };
}

/** BYO-key completer — thin wrapper over chatLogged so both paths share one signature. */
export function apiCompleter(): Completer {
  return (tool, messages, opts = {}) =>
    chatLogged(tool, messages, {
      responseFormat: 'json_object',
      temperature:    opts.temperature,
      maxTokens:      opts.maxTokens,
      jobId:          opts.jobId,
    });
}

function logLlmCall(tool: string, result: ChatLogged, jobId?: string): void {
  try {
    getDb().prepare(`
      INSERT INTO llm_calls
        (id, tool, provider, model, job_id, input_chars, output_chars,
         parse_ok, parse_error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id, tool, result.provider, result.model, jobId ?? null,
      result.inputChars, result.outputChars,
      result.parseOk ? 1 : 0, result.parseError ?? null,
      result.durationMs,
    );
  } catch {
    // Telemetry must never break the caller.
  }
}
