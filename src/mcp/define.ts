// Tool-registration pattern.
//
// Each tool file exports a single `ToolDef` from `defineTool({...})`. The MCP server
// registers them all in one loop (see src/mcp/server.ts). Benefits:
//   - one place to standardize result shape (okResult / errResult)
//   - tools/list comes from a single typed array; adding a new tool is one import + one
//     line in the registry
//   - tests can call `tool.handler(args)` directly without spinning up the transport
//
// Conventions:
//   - inputSchema is a `ZodRawShape` (object map of zod types), NOT a full ZodObject
//   - handler returns `ToolResult` — okResult(payload) for success, errResult(msg) for failure
//   - any tool that does writes must wrap the write in `runInWriteLock(...)`

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: object;
  isError?: boolean;
};

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name:        string;
  title:       string;
  description: string;
  inputSchema: S;
  handler:     (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult> | ToolResult;
}

export function defineTool<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

// The registry holds heterogeneously-typed ToolDef<S> values. TS's invariance on
// handler args means we can't store them as `ToolDef<ZodRawShape>[]` directly, so the
// registry signature uses `ToolDef<any>` and casts inside.
export type AnyToolDef = ToolDef<any>;

export function registerTools(server: McpServer, tools: ReadonlyArray<AnyToolDef>): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema },
      t.handler as any,
    );
  }
}

// ── Shared result helpers ────────────────────────────────────────────────────

export function okResult(payload: object): ToolResult {
  return {
    content:           [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function errResult(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
