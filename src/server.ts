// Entrypoint. One process: SQLite migrations, Express + file server, MCP HTTP transport.
import { buildHttpApp } from './http/app.js';
import { mountMcp } from './mcp/server.js';
import { config } from './config.js';
import { getDb } from './db.js';
import { ensureActiveCareerPacket, loadProjectFiles } from './core/profile.js';
import { closeBrowser } from './core/render.js';
import { shutdownScanResources } from './core/scan_engine.js';
import { applyState as applySchedulerState, readEnabledJobs } from './core/scheduler.js';

async function main(): Promise<void> {
  // Trigger migrations (side effect of getDb()).
  getDb();
  const seed = ensureActiveCareerPacket();
  const files = loadProjectFiles();

  const app = buildHttpApp();
  mountMcp(app, '/mcp');
  applySchedulerState();
  const enabled = readEnabledJobs();

  const server = app.listen(config.port, config.host, () => {
    const baseUrl = config.baseUrl;
    // eslint-disable-next-line no-console
    console.error([
      '',
      `▷ mcp-jsa listening on ${baseUrl}`,
      `  · MCP endpoint:   ${baseUrl}/mcp`,
      `  · Tracker UI:     ${baseUrl}/`,
      `  · File server:    ${baseUrl}/files/*`,
      `  · DB:             ${config.dbPath}`,
      `  · Project root:   ${config.projectRoot}`,
      `  · cv.md present:  ${!!files.cvMd}`,
      `  · profile.yml:    ${!!files.profile}`,
      `  · portals.yml:    ${!!files.portalsYml}`,
      `  · career_packet:  ${seed.created ? `seeded v${seed.version}` : `existing v${seed.version}`}`,
      `  · scheduler:      ${enabled.length ? enabled.join(', ') : 'off'}`,
      `  · visa scoring:   ${config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`,
      '',
    ].join('\n'));
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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', err);
  process.exit(1);
});
