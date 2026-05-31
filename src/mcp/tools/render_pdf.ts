import { z } from 'zod';

import { renderPdf } from '../../core/render.js';
import { defineTool, okResult, errResult } from '../define.js';

export const renderPdfTool = defineTool({
  name: 'render_pdf',
  title: 'Render resume/cover PDF',
  description: 'HTML → PDF via Playwright using the career-ops template. Returns a localhost link for each file.',
  inputSchema: {
    job_id:      z.string().min(1),
    kind:        z.enum(['resume', 'cover', 'both']).default('resume'),
    cover_body:  z.string().optional().describe('Plain-prose cover letter body (used when kind includes cover). 250-350 words.'),
    page_format: z.enum(['a4', 'letter']).default('letter'),
  },
  handler: async (args) => {
    try {
      const files = await renderPdf(args);
      return okResult({
        job_id: args.job_id,
        files: files.map(f => ({ kind: f.kind, url: f.url, bytes: f.bytes, path: f.path })),
      });
    } catch (err: any) {
      return errResult(`render_pdf failed: ${err?.message ?? String(err)}`);
    }
  },
});
