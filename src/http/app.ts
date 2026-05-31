// Express app: tracker dashboard, /files static server, /healthz, and the /mcp transport.
// The MCP HTTP transport is mounted from src/mcp/server.ts onto the same Express instance
// so users only need to expose one port to their chat client.
import express, { type Express, type Request, type Response } from 'express';
import { resolve, normalize, relative, sep } from 'node:path';

import { config } from '../config.js';
import { renderDashboard } from './dashboard.js';

export function buildHttpApp(): Express {
  const app = express();

  // Body parser — MCP transport uses JSON-RPC; raise the limit slightly so chat clients
  // can POST report bodies on step 2 of evaluate_job.
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, baseUrl: config.baseUrl });
  });

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
