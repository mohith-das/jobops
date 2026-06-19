// Auth for the remote / PII surface.
//
// The HTTP server exposes resume PDFs (/files), the tracker dashboard (/), and the MCP
// endpoint (/mcp) — all of which can surface PII (resume contents, LinkedIn connections,
// H1B-derived employer signal). When the server is bound to anything other than localhost,
// that surface MUST NOT be reachable unauthenticated.
//
// Policy (see resolveAuthPolicy):
//   • localhost bind, no token            → OPEN     (frictionless single-user local use)
//   • localhost bind, token set           → TOKEN    (opt-in bearer auth even locally)
//   • non-localhost bind, no token        → DENY     (default-deny; server refuses to boot)
//   • non-localhost bind, token set       → TOKEN    (bearer auth required on PII + /mcp)
//
// This aligns with the MCP 2025-06-18 "MCP server as OAuth Resource Server" model to the
// extent practical for a self-hosted single-user tool: a required bearer token gates the
// resource, 401s carry a WWW-Authenticate header pointing at the protected-resource
// metadata document, and the token is verified through an OAuthTokenVerifier. Full OAuth
// authorization-server flows (dynamic client registration, token issuance) are out of
// scope — the operator sets one static token via JOBOPS_AUTH_TOKEN.

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

// Hostnames that mean "loopback only" — not reachable from other machines.
const LOCALHOST_HOSTS = new Set([
  '127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1',
]);

export function isLocalhostHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return LOCALHOST_HOSTS.has(host.trim().toLowerCase());
}

export type AuthMode = 'open' | 'token' | 'deny';

export interface AuthPolicy {
  mode:         AuthMode;
  /** True when a bearer token must be presented on PII + /mcp routes. */
  requireToken: boolean;
  isLocalhost:  boolean;
  token:        string | null;
  /** Human-readable explanation — shown at boot + by doctor. */
  reason:       string;
}

/**
 * Pure decision function — given the bind host and the configured token, decide the auth
 * posture. Exported so tests can assert every branch without booting the server.
 */
export function resolveAuthPolicy(args: { host: string; token: string | null | undefined }): AuthPolicy {
  const isLocalhost = isLocalhostHost(args.host);
  const token = (args.token ?? '').trim() || null;

  if (isLocalhost) {
    if (token) {
      return { mode: 'token', requireToken: true, isLocalhost, token,
               reason: 'localhost bind with JOBOPS_AUTH_TOKEN set — bearer auth enforced even locally' };
    }
    return { mode: 'open', requireToken: false, isLocalhost, token: null,
             reason: 'localhost-only bind — frictionless, no token required' };
  }

  if (!token) {
    return { mode: 'deny', requireToken: true, isLocalhost, token: null,
             reason: 'non-localhost bind without JOBOPS_AUTH_TOKEN — remote access DENIED (default-deny). '
                   + 'Set JOBOPS_AUTH_TOKEN to a strong secret to expose this server beyond localhost.' };
  }
  return { mode: 'token', requireToken: true, isLocalhost, token,
           reason: 'non-localhost bind with JOBOPS_AUTH_TOKEN — bearer auth required on /mcp, /files, and dashboard' };
}

// Constant-time string compare (avoids leaking the token length-by-length via timing).
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a compare against self to burn ~equal time, then return false.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Extract a Bearer token from an Authorization header. Returns null when absent/malformed. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * An OAuthTokenVerifier backed by a single static operator-provided token. Aligns the
 * request path with the SDK's resource-server interface; on mismatch it throws so the
 * caller returns 401.
 */
export class StaticTokenVerifier implements OAuthTokenVerifier {
  constructor(private readonly token: string, private readonly resource?: URL) {}
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!tokensMatch(token, this.token)) {
      throw new Error('invalid_token');
    }
    return {
      token,
      clientId: 'jobops-operator',
      scopes:   ['mcp:full'],
      resource: this.resource,
    };
  }
}

/**
 * Express middleware enforcing the static bearer token on a protected route. Emits a
 * spec-shaped 401 with a WWW-Authenticate header that points at the protected-resource
 * metadata document (so a compliant client can discover how to authenticate).
 */
export function bearerAuthMiddleware(token: string, resourceMetadataUrl?: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const presented = bearerFromHeader(req.headers['authorization'] as string | undefined);
    if (presented && tokensMatch(presented, token)) {
      (req as any).auth = { token: presented, clientId: 'jobops-operator', scopes: ['mcp:full'] } satisfies AuthInfo;
      return next();
    }
    const meta = resourceMetadataUrl ? `, resource_metadata="${resourceMetadataUrl}"` : '';
    res.setHeader('WWW-Authenticate', `Bearer realm="jobops"${meta}`);
    res.status(401).json({
      error: 'unauthorized',
      error_description: presented
        ? 'Invalid bearer token.'
        : 'Missing bearer token. This server requires Authorization: Bearer <token> because it is bound to a non-localhost address (or JOBOPS_AUTH_TOKEN is set).',
    });
  };
}

/**
 * RFC 9728-style protected-resource metadata. Minimal but spec-shaped so a client can
 * discover the resource identifier + the bearer scheme.
 */
export function protectedResourceMetadata(resourceUrl: string): Record<string, unknown> {
  return {
    resource: resourceUrl,
    bearer_methods_supported: ['header'],
    resource_name: 'jobops',
    // No external authorization server — the operator provisions a static token.
    authorization_servers: [],
    scopes_supported: ['mcp:full'],
  };
}
