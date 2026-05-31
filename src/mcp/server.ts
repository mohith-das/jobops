// MCP server wiring.
//
// Stateless mode: one fresh McpServer per HTTP request. For a local single-user process
// the per-request setup is microseconds and the lifecycle is dramatically simpler than
// session-based mode (no Map<sessionId, transport>, no GC).
//
// Tool registration follows src/mcp/define.ts — every tool exports a single ToolDef.
// To add a tool: write src/mcp/tools/<name>.ts that exports `<name>Tool`, import it
// below, and add it to ALL_TOOLS. resources/list comes from src/core/resources.ts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Express, Request, Response } from 'express';

import { config } from '../config.js';
import { listResources } from '../core/resources.js';
import { registerTools, type AnyToolDef } from './define.js';

// ── Tool imports ─────────────────────────────────────────────────────────────
// Keep this block ordered by the brief's grouping for at-a-glance navigation.

// M1 — eval & PDFs
import { evaluateJobTool } from './tools/evaluate_job.js';
import { renderPdfTool    } from './tools/render_pdf.js';
import { getReportTool    } from './tools/get_report.js';

// G1 — tracker queries + mutators
import { getTopJobsTool, getTrackerTool, updateStatusTool, markReadyToApplyTool } from './tools/tracker.js';

// G2 — portal scanner
import { scanPortalsTool } from './tools/scan_portals.js';

// G3 — outreach
import {
  findWarmIntrosTool, findFoundersTool, draftOutreachTool, getOutreachQueueTool,
  updateOutreachTool, getFollowupsDueTool, draftFollowupTool, draftReplyTool,
} from './tools/outreach.js';

// G4 — visa
import { visaSignalTool, importH1bTool, importLinkedinTool } from './tools/visa.js';

// G5 — stories + negotiation
import { extractStoriesTool, getStoryBankTool, negotiationBriefTool } from './tools/stories.js';

// G6 — batch + materials
import { batchEvaluateTool   } from './tools/batch_evaluate.js';
import { generateMaterialsTool } from './tools/generate_materials.js';

// G7 — training/project/research/digest + profile ops
import {
  evaluateTrainingTool, evaluateProjectTool, deepResearchTool, dailyDigestTool,
  getCareerPacketTool, updateCareerPacketTool, enrichCompanyTool, costEstimateTool,
} from './tools/ops.js';

// G8 — apply prefill
import { applyPrefillTool } from './tools/apply_prefill.js';

// G9 — scheduler
import { schedulerStatusTool, schedulerEnableTool, schedulerDisableTool } from './tools/scheduler.js';

// Tools tagged "visa" are hidden from tools/list when MCP_JSA_VISA_SCORING=false.
const VISA_TOOL_NAMES: ReadonlySet<string> = new Set([
  'visa_signal', 'import_h1b', 'import_linkedin',
]);

const FULL_TOOLSET: AnyToolDef[] = [
  evaluateJobTool, renderPdfTool, getReportTool,
  getTopJobsTool, getTrackerTool, updateStatusTool, markReadyToApplyTool,
  scanPortalsTool,
  findWarmIntrosTool, findFoundersTool, draftOutreachTool, getOutreachQueueTool,
  updateOutreachTool, getFollowupsDueTool, draftFollowupTool, draftReplyTool,
  visaSignalTool, importH1bTool, importLinkedinTool,
  extractStoriesTool, getStoryBankTool, negotiationBriefTool,
  batchEvaluateTool, generateMaterialsTool,
  evaluateTrainingTool, evaluateProjectTool, deepResearchTool, dailyDigestTool,
  getCareerPacketTool, updateCareerPacketTool, enrichCompanyTool, costEstimateTool,
  applyPrefillTool,
  schedulerStatusTool, schedulerEnableTool, schedulerDisableTool,
];

const ALL_TOOLS: AnyToolDef[] = config.visaScoringEnabled
  ? FULL_TOOLSET
  : FULL_TOOLSET.filter(t => !VISA_TOOL_NAMES.has(t.name));

// Tools and resources are static — one McpServer instance is reused across all requests.
// Only the transport is per-request in stateless mode.
let _server: McpServer | null = null;
function getMcpServer(): McpServer {
  if (_server) return _server;
  _server = new McpServer({ name: 'mcp-jsa', version: '0.2.0' });
  registerTools(_server, ALL_TOOLS);
  for (const r of listResources()) {
    _server.registerResource(
      r.name, r.uri,
      { title: r.title, description: r.description, mimeType: r.mimeType },
      async () => ({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.body() }] }),
    );
  }
  return _server;
}

export function mountMcp(app: Express, path = '/mcp'): void {
  const server = getMcpServer();
  const handle = async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error:   { code: -32603, message: err?.message ?? 'internal error' },
          id:      null,
        });
      }
    }
  };

  app.post(path, handle);
  app.get(path,    (_req: Request, res: Response) => res.status(405).end());
  app.delete(path, (_req: Request, res: Response) => res.status(405).end());
}

export function listAllTools(): AnyToolDef[] { return ALL_TOOLS; }

// ── stdio transport ─────────────────────────────────────────────────────────
// Used by Claude Desktop and any other MCP client that only speaks stdio.
// Blocks until stdin closes (the client disconnects). In stdio mode the caller
// must keep stdout clean — all logging in this process already goes to stderr.
export async function serveStdio(): Promise<void> {
  const server = getMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until transport closes; transport.onclose fires when stdin EOFs.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
