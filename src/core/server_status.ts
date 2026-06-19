// Runtime identity for the "one shared server, many clients" topology.
//
// Tracks what this PROCESS has seen since boot: which MCP clients initialized
// (name/version from the initialize handshake + remote address), how many MCP
// requests were handled, which transport mode is active, and which DB file this
// process owns. Surfaced three ways, all read-only:
//   - GET /api/status            (auth-gated JSON — the CLI `status` command hits this)
//   - the `doctor` MCP tool      (a "Server" check row in server context)
//   - `npx @mohith_das/jobops status`   (CLI, queries a RUNNING server over HTTP)
//
// The point: a user running several clients (Claude Desktop, Claude Code,
// opencode, codex, …) against one server can VERIFY they all hit the same
// process + same DB. Client counting is best-effort by design — the stateless
// streamable-HTTP transport has no sessions, so "connected" means "sent an
// initialize through this process", keyed by clientInfo + remote address.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';

export interface ClientSeen {
  /** clientInfo.name from the MCP initialize handshake (e.g. "claude-ai", "opencode"). */
  name:        string;
  version:     string;
  /** Remote address the initialize arrived from ("stdio" for the stdio transport). */
  remote:      string;
  first_seen:  string;
  last_seen:   string;
  /** Number of initialize handshakes seen from this client identity. */
  initializes: number;
}

export interface ServerStatus {
  package:            string;
  version:            string;
  pid:                number;
  started_at:         string;
  uptime_s:           number;
  transport_mode:     'http' | 'stdio' | 'unknown';
  db_path:            string;
  /** Short stable fingerprint of db_path — two clients comparing status output can match on this. */
  db_fingerprint:     string;
  project_root:       string;
  listen_url:         string;
  public_base_url:    string;
  auth_mode:          string;
  mcp_requests_total: number;
  clients_seen:       ClientSeen[];
}

const startedAt = new Date(Date.now() - process.uptime() * 1000);
let transportMode: ServerStatus['transport_mode'] = 'unknown';
let mcpRequests = 0;
const clients = new Map<string, ClientSeen>();

export function setTransportMode(mode: 'http' | 'stdio'): void {
  transportMode = mode;
}

export function recordMcpRequest(): void {
  mcpRequests++;
}

/** Record an MCP initialize handshake. Call with the clientInfo from the request params. */
export function recordClientInitialize(args: { name?: string; version?: string; remote?: string }): void {
  const name    = (args.name ?? 'unknown-client').trim() || 'unknown-client';
  const version = (args.version ?? '?').trim() || '?';
  const remote  = (args.remote ?? '?').trim() || '?';
  const key = `${name}@${version} ${remote}`;
  const now = new Date().toISOString();
  const existing = clients.get(key);
  if (existing) {
    existing.last_seen = now;
    existing.initializes++;
  } else {
    clients.set(key, { name, version, remote, first_seen: now, last_seen: now, initializes: 1 });
  }
}

function pkgInfo(): { name: string; version: string } {
  try {
    const p = JSON.parse(readFileSync(resolve(config.installDir, 'package.json'), 'utf-8'));
    return { name: p.name ?? 'jobops', version: p.version ?? '0.0.0' };
  } catch { return { name: 'jobops', version: 'unknown' }; }
}

export function serverStatus(): ServerStatus {
  const pkg = pkgInfo();
  return {
    package:            pkg.name,
    version:            pkg.version,
    pid:                process.pid,
    started_at:         startedAt.toISOString(),
    uptime_s:           Math.round(process.uptime()),
    transport_mode:     transportMode,
    db_path:            config.dbPath,
    db_fingerprint:     createHash('sha256').update(config.dbPath).digest('hex').slice(0, 12),
    project_root:       config.projectRoot,
    listen_url:         config.listenUrl,
    public_base_url:    config.publicBaseUrl,
    auth_mode:          config.authPolicy.mode,
    mcp_requests_total: mcpRequests,
    clients_seen:       [...clients.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen)),
  };
}
