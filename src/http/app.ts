// Express app: tracker dashboard, /files static server, /healthz, and the /mcp transport.
// The MCP HTTP transport is mounted from src/mcp/server.ts onto the same Express instance
// so users only need to expose one port to their chat client.
//
// Auth: when config.authPolicy.requireToken is true (non-localhost bind, or a token set
// even locally), every PII-bearing route — the dashboard (/), /files/*, and /mcp — is
// gated behind a bearer token. /healthz stays open (no PII) so liveness probes work, and
// the protected-resource metadata document is served unauthenticated for discovery.
import express, { type Express, type Request, type Response } from 'express';
import { resolve, normalize, relative, sep } from 'node:path';

import { config } from '../config.js';
import { renderDashboard } from './dashboard.js';
import { bearerAuthMiddleware, protectedResourceMetadata } from '../core/auth.js';
import { mountElicit } from './elicit.js';

export function buildHttpApp(): Express {
  const app = express();

  // Body parser — MCP transport uses JSON-RPC; raise the limit slightly so chat clients
  // can POST report bodies on step 2 of evaluate_job.
  app.use(express.json({ limit: '4mb' }));

  // Liveness — always open, never serves PII.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      listenUrl: config.listenUrl,
      publicBaseUrl: config.publicBaseUrl,
      auth: config.authPolicy.mode,
    });
  });

  // Protected-resource metadata (RFC 9728-shaped) — discovery, always open.
  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(`${config.publicBaseUrl}/mcp`));
  });

  // URL-mode elicitation capture (sensitive inputs entered out-of-band, never via the MCP
  // client). Mounted before the auth guard — the one-time unguessable id is the capability.
  // Needs urlencoded form parsing for the POST.
  app.use(express.urlencoded({ extended: false }));
  mountElicit(app, '/elicit');

  // Gate the PII surface when the policy demands a token. Mounted BEFORE the routes so it
  // covers the dashboard, /files, and (via mountMcp, which runs after this) /mcp.
  if (config.authPolicy.requireToken && config.authPolicy.token) {
    const guard = bearerAuthMiddleware(config.authPolicy.token, resourceMetadataUrl);
    app.use((req: Request, res: Response, next) => {
      // Allow-list the always-open routes; everything else needs the token.
      if (req.path === '/healthz' || req.path === '/.well-known/oauth-protected-resource') {
        return next();
      }
      return guard(req, res, next);
    });
  }

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(renderDashboard());
  });

  // /files/* — serve anything under outputDir. Path traversal guarded.
  app.get('/files/*', (req: Request, res: Response) => {
    const raw = (req.params as any)[0] as string;
    const abs = normalize(resolve(config.outputDir, raw));
    const rel = relative(config.outputDir, abs);
    if (rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || abs === config.outputDir) {
      res.status(403).send('forbidden');
      return;
    }
    res.sendFile(abs, (err) => {
      if (err) res.status(404).send('not found');
    });
  });

  return app;
}
