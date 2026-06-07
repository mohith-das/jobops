// ClientBridge — the server→client request surface (MCP sampling + elicitation).
//
// MCP lets a server ask the *connected client* to do work on its behalf:
//   • sampling  (sampling/createMessage)  — run a completion on the client's own model,
//                                            so the user needs no separate LLM API key;
//   • elicitation (elicitation/create)    — request structured input from the user, in
//                                            form mode (JSON-schema fields) or URL mode
//                                            (send the user to a URL for sensitive input
//                                            that must NOT pass through the MCP client).
//
// Both are CAPABILITY-GATED: a client advertises `sampling` / `elicitation` during
// initialize, and we only attempt the call when the capability is present. Older clients
// that advertise neither degrade gracefully — callers fall back to the BYO-key LLM path
// and the file/env config path respectively.
//
// This interface is deliberately framework-free so unit tests can inject a mock client
// (the real one wraps the McpServer's underlying Server + its connected transport).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Transport duplex capability ───────────────────────────────────────────────
//
// Sampling + elicitation are server→client REQUESTS. They can only be delivered when the
// active transport carries bidirectional traffic. stdio does. Our HTTP transport runs in
// stateless + JSON-response mode (one POST → one JSON reply), where the SDK silently drops
// server-initiated requests — so over HTTP these features can't complete and a client that
// merely *advertises* the capability would hang until timeout. We therefore gate on the
// transport, not just the advertised capability: HTTP clients fall back cleanly to the
// BYO-key scoring path + the file/arg config paths.
let _duplexCapable = false;
/** Called by the stdio entrypoint — stdio can carry server→client requests. */
export function setDuplexCapable(v: boolean): void { _duplexCapable = v; }
export function isDuplexCapable(): boolean { return _duplexCapable; }

// ── Sampling ──────────────────────────────────────────────────────────────────

export interface SampleRequest {
  system?:      string;
  messages:     { role: 'user' | 'assistant'; content: string }[];
  maxTokens?:   number;
  temperature?: number;
}

export interface SampleResponse {
  text:  string;
  model: string;
}

// ── Elicitation ─────────────────────────────────────────────────────────────--

export type ElicitAction = 'accept' | 'decline' | 'cancel';

/** A minimal JSON-schema object the client renders as a form. */
export interface ElicitObjectSchema {
  type:       'object';
  properties: Record<string, unknown>;
  required?:  string[];
}

export interface ElicitFormRequest {
  message:         string;
  requestedSchema: ElicitObjectSchema;
}

export interface ElicitUrlRequest {
  message:          string;
  url:              string;
  requestedSchema?: ElicitObjectSchema;
}

export interface ElicitResponse {
  action:   ElicitAction;
  content?: Record<string, string | number | boolean | string[]>;
}

// ── Interface ───────────────────────────────────────────────────────────────--

export interface ClientBridge {
  canSample():    boolean;
  canElicit():    boolean;   // form-mode elicitation
  canElicitUrl(): boolean;   // URL-mode elicitation (2025-11-25)
  sample(req: SampleRequest):          Promise<SampleResponse>;
  elicitForm(req: ElicitFormRequest):  Promise<ElicitResponse>;
  elicitUrl(req: ElicitUrlRequest):    Promise<ElicitResponse>;
}

// ── Real implementation (wraps the connected McpServer) ─────────────────────--

export class RealClientBridge implements ClientBridge {
  constructor(private readonly server: McpServer) {}

  private caps() {
    try { return this.server.server.getClientCapabilities(); }
    catch { return undefined; }
  }

  // Gate on BOTH the transport (can it deliver a server→client request?) and the client's
  // advertised capability. For elicitation we check the specific sub-mode the SDK requires
  // (`.form` / `.url`) — a URL-only client must not pass canElicit() and then hit a form-mode
  // throw inside the SDK.
  canSample(): boolean    { return isDuplexCapable() && !!this.caps()?.sampling; }
  canElicit(): boolean    { return isDuplexCapable() && !!(this.caps()?.elicitation as any)?.form; }
  canElicitUrl(): boolean { return isDuplexCapable() && !!(this.caps()?.elicitation as any)?.url; }

  async sample(req: SampleRequest): Promise<SampleResponse> {
    const result = await this.server.server.createMessage({
      messages: req.messages.map(m => ({
        role: m.role,
        content: { type: 'text' as const, text: m.content },
      })),
      systemPrompt: req.system,
      maxTokens:    req.maxTokens ?? 4096,
      temperature:  req.temperature,
    });
    const content: any = result.content;
    const text = content && content.type === 'text' ? String(content.text ?? '') : '';
    return { text, model: result.model ?? 'client' };
  }

  async elicitForm(req: ElicitFormRequest): Promise<ElicitResponse> {
    const r = await this.server.server.elicitInput({
      message:         req.message,
      requestedSchema: req.requestedSchema as any,
    });
    return { action: r.action as ElicitAction, content: r.content as any };
  }

  async elicitUrl(req: ElicitUrlRequest): Promise<ElicitResponse> {
    const r = await this.server.server.elicitInput({
      mode:            'url',
      message:         req.message,
      url:             req.url,
      requestedSchema: req.requestedSchema as any,
    } as any);
    return { action: r.action as ElicitAction, content: r.content as any };
  }
}

// A bridge that reports no capabilities — used when no client is connected (e.g. a tool
// invoked outside a live MCP session). Every attempt throws; callers gate on canX() first.
export const NULL_BRIDGE: ClientBridge = {
  canSample:    () => false,
  canElicit:    () => false,
  canElicitUrl: () => false,
  sample:    async () => { throw new Error('no MCP client connected (sampling unavailable)'); },
  elicitForm: async () => { throw new Error('no MCP client connected (elicitation unavailable)'); },
  elicitUrl:  async () => { throw new Error('no MCP client connected (elicitation unavailable)'); },
};

export interface ToolContext {
  bridge: ClientBridge;
}
