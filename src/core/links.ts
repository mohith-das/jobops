// Single source of truth for artifact links emitted by every tool.
//
// Every URL the server returns (resume / cover PDF, .tex, .docx, eval report HTML,
// apply_prefill screenshot, tracker home) flows through one of these helpers. The
// helpers read `config.publicBaseUrl` which is either MCP_JSA_PUBLIC_BASE_URL (when
// set + valid) or the local listen URL (the default — preserves the original
// 127.0.0.1:7891 behaviour for local-only users).
//
// Each helper accepts an optional `base` override so unit tests can exercise the
// formatting logic without depending on the module-level config state.

import { config } from '../config.js';

/** Strip trailing slashes so we never emit `//files/...`. */
function trimSlash(u: string): string { return u.replace(/\/+$/, ''); }

/**
 * URL for a file served by Express at `/files/*`. `relPath` is the path under
 * `outputDir` (e.g. `pdfs/resume-foo-9a1b.pdf`).
 */
export function fileUrl(relPath: string, base: string = config.publicBaseUrl): string {
  const p = (relPath ?? '').replace(/^\/+/, '');
  return `${trimSlash(base)}/files/${p}`;
}

/** URL of the tracker dashboard root. */
export function trackerUrl(base: string = config.publicBaseUrl): string {
  return `${trimSlash(base)}/`;
}

/** URL of the MCP endpoint. Used by `connect` to print client config blocks. */
export function mcpUrl(base: string = config.publicBaseUrl): string {
  return `${trimSlash(base)}/mcp`;
}
