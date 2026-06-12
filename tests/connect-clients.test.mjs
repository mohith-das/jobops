// `connect` must emit shared-HTTP config for EVERY supported client, pointed at the
// ONE running server — and include the bearer token in each config when set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '..', 'dist', 'cli.js');

function runConnect(env = {}) {
  const r = spawnSync(process.execPath, [CLI, 'connect'], {
    encoding: 'utf-8',
    env: { ...process.env, MCP_JSA_AUTH_TOKEN: '', MCP_JSA_PUBLIC_BASE_URL: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('connect emits a config block for every client, all pointing at ONE shared URL', () => {
  const out = runConnect();
  const url = 'http://127.0.0.1:7891/mcp';

  // The topology statement itself.
  assert.match(out, /ONE long-running server = ONE source of truth/);

  // Every client section is present.
  for (const client of ['Claude Code', 'Claude Desktop', 'opencode', 'codex', 'gemini-cli', 'LibreChat']) {
    assert.ok(out.includes(client), `missing client section: ${client}`);
  }

  // Each format points at the SAME shared endpoint.
  assert.match(out, new RegExp(`claude mcp add --transport http job_ops-mcp ${url}`));          // Claude Code
  assert.match(out, /"type": "http",\s*\n\s*"url": "http:\/\/127\.0\.0\.1:7891\/mcp"/);          // .mcp.json
  assert.match(out, /"mcp-remote",\s*\n?\s*"http:\/\/127\.0\.0\.1:7891\/mcp"/);                  // Desktop bridge
  assert.match(out, /"type": "remote",\s*\n\s*"url": "http:\/\/127\.0\.0\.1:7891\/mcp"/);        // opencode
  assert.match(out, /\[mcp_servers\.job_ops_mcp\]\nurl = "http:\/\/127\.0\.0\.1:7891\/mcp"/);    // codex TOML
  assert.match(out, /"httpUrl": "http:\/\/127\.0\.0\.1:7891\/mcp"/);                             // gemini-cli
  assert.match(out, /type: streamable-http/);                                                    // LibreChat

  // stdio stays available as the documented single-client alternative, with the tradeoff.
  assert.match(out, /stdio mode — single-client alternative \(NOT shared\)/);
  assert.match(out, /EADDRINUSE/);

  // The mcp-remote × Node >= 26 known-issue warning must ship with the Desktop bridge
  // config — without it, Homebrew-Node users hit "Unexpected content type: null" blind.
  assert.match(out, /KNOWN ISSUE: mcp-remote/);
  assert.match(out, /Node >= 26/);
  assert.match(out, /Unexpected content\s*\n?\s*type: null/);

  // No token set on localhost → the auth guidance is shown instead of headers.
  assert.match(out, /MUST set\s*\n?\s*MCP_JSA_AUTH_TOKEN/);
  assert.doesNotMatch(out, /Authorization: Bearer/);
});

test('connect with MCP_JSA_AUTH_TOKEN embeds the bearer token in every HTTP config', () => {
  const out = runConnect({ MCP_JSA_AUTH_TOKEN: 'tok-abc123' });

  const headerCount = (out.match(/Bearer tok-abc123/g) ?? []).length;
  // Claude Code (CLI + .mcp.json), Desktop bridge, opencode, gemini, LibreChat ×2, generic…
  assert.ok(headerCount >= 6, `expected the token in >= 6 config blocks, found ${headerCount}`);
  // codex reads it from the env var instead of inline.
  assert.match(out, /bearer_token_env_var = "MCP_JSA_AUTH_TOKEN"/);
});

test('connect respects MCP_JSA_PUBLIC_BASE_URL (remote / Tailscale host)', () => {
  const out = runConnect({ MCP_JSA_PUBLIC_BASE_URL: 'http://ampere.tail1234.ts.net:7891', MCP_JSA_AUTH_TOKEN: 'tok' });
  assert.match(out, /http:\/\/ampere\.tail1234\.ts\.net:7891\/mcp/);
  assert.doesNotMatch(out, /"url": "http:\/\/127\.0\.0\.1:7891\/mcp"/);
});

test('status command points at a non-running server → clear failure', () => {
  const r = spawnSync(process.execPath, [CLI, 'status', '--url', 'http://127.0.0.1:1'], {
    encoding: 'utf-8',
    env: { ...process.env, MCP_JSA_AUTH_TOKEN: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No server reachable/);
  assert.match(r.stdout, /npx job_ops-mcp start/);
});
