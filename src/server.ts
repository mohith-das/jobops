// Entrypoint. One process, two transport modes:
//
//   HTTP   (default)   — npx job_ops-mcp start
//     MCP transport + file server + tracker dashboard, all on MCP_JSA_PORT.
//
//   stdio  (Claude Desktop)  — npx job_ops-mcp start --stdio
//     MCP transport on stdin/stdout; HTTP file server still runs on the port
//     so /files/* artifact links the chat returns still resolve in a browser.
//
// In stdio mode all logging MUST go to stderr — stdout is the MCP channel.
import { buildHttpApp } from './http/app.js';
import { mountMcp, serveStdio } from './mcp/server.js';
import { config } from './config.js';
import { getDb } from './db.js';
import { ensureActiveCareerPacket, loadProjectFiles } from './core/profile.js';
import { closeBrowser } from './core/render.js';
import { shutdownScanResources } from './core/scan_engine.js';
import { applyState as applySchedulerState, readEnabledJobs } from './core/scheduler.js';

export interface BootOptions {
  stdio?: boolean;
}

export async function bootServer(opts: BootOptions = {}): Promise<void> {
  // Migrations + first-run seeding (side-effect of getDb()).
  getDb();
  const seed = await ensureActiveCareerPacket();
  const files = loadProjectFiles();

  const app = buildHttpApp();
  // In stdio mode we DON'T mount /mcp — MCP rides stdin/stdout instead.
  // The Express server still runs so /files/* artifact links resolve.
  if (!opts.stdio) {
    mountMcp(app, '/mcp');
  }
  applySchedulerState();
  const enabled = readEnabledJobs();

  const server = app.listen(config.port, config.host, () => {
    const lines = opts.stdio
      ? [
          '',
          `▷ job_ops-mcp stdio mode`,
          `  · MCP transport:  stdin/stdout`,
          `  · File server:    ${config.baseUrl}/files/*  (for artifact links)`,
          `  · Tracker UI:     ${config.baseUrl}/`,
          `  · DB:             ${config.dbPath}`,
          `  · Project root:   ${config.projectRoot}`,
          `  · career_packet:  ${seed.created ? `seeded v${seed.version}` : `existing v${seed.version}`}`,
          `  · scheduler:      ${enabled.length ? enabled.join(', ') : 'off'}`,
          `  · visa scoring:   ${config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`,
          '',
        ]
      : [
          '',
          `▷ job_ops-mcp listening on ${config.baseUrl}`,
          `  · MCP endpoint:   ${config.baseUrl}/mcp`,
          `  · Tracker UI:     ${config.baseUrl}/`,
          `  · File server:    ${config.baseUrl}/files/*`,
          `  · DB:             ${config.dbPath}`,
          `  · Project root:   ${config.projectRoot}`,
          `  · cv.md present:  ${!!files.cvMd}`,
          `  · profile.yml:    ${!!files.profile}`,
          `  · portals.yml:    ${!!files.portalsYml}`,
          `  · career_packet:  ${seed.created ? `seeded v${seed.version}` : `existing v${seed.version}`}`,
          `  · scheduler:      ${enabled.length ? enabled.join(', ') : 'off'}`,
          `  · visa scoring:   ${config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`,
          '',
        ];
    // eslint-disable-next-line no-console
    console.error(lines.join('\n'));
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.error(`\n[shutdown] ${signal} received`);
    server.close();
    await closeBrowser();
    await shutdownScanResources();
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  if (opts.stdio) {
    // Block here until the stdio client disconnects (stdin EOFs).
    // The HTTP file server keeps serving /files/* in parallel.
    await serveStdio();
    // eslint-disable-next-line no-console
    console.error('[shutdown] stdio client disconnected');
    server.close();
    await closeBrowser();
    await shutdownScanResources();
    process.exit(0);
  }
}
