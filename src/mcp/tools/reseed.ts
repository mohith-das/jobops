// reseed_career_packet — rebuild the active career_packet from the current cv.md +
// config/profile.yml. Bumps version, demotes the previous active row (history kept).
// Same underlying logic as the CLI `reseed` subcommand.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { seedCareerPacketFromFiles, loadProjectFiles, cvHasRealContent, packetPreview } from '../../core/profile.js';

export const reseedCareerPacketTool = defineTool({
  name: 'reseed_career_packet',
  title: 'Rebuild the career packet from cv.md + profile.yml',
  description:
    'Re-reads cv.md and config/profile.yml and writes a NEW active career_packet ' +
    'version, demoting the previous one (history retained). Use after editing cv.md so ' +
    'the chat sees your real bullets, not the <TODO> template. Identity comes from ' +
    'profile.yml; bullets / projects / skills / education come from cv.md.',
  inputSchema: {
    confirm_empty_cv: z.boolean().optional()
      .describe('cv.md missing or trivially small? Set true to seed identity-only anyway. Default false (errors instead).'),
  },
  handler: async (args) => {
    const { cvMd } = loadProjectFiles();
    if (!cvHasRealContent(cvMd) && !args.confirm_empty_cv) {
      return errResult(
        'cv.md is missing or still looks like the <TODO> example template. ' +
        'Fill it in first, then re-run. Pass confirm_empty_cv=true to reseed anyway ' +
        '(identity-only — most sections will stay as <TODO> placeholders).',
      );
    }
    const r = await seedCareerPacketFromFiles({ mode: 'reseed' });
    return okResult({
      ok: true,
      new_version:               r.version,
      bytes:                     r.bytes,
      sections_with_cv_content:  r.sections_with_cv_content,
      sections_max:              6,
      preview:                   packetPreview(r.preview, 400),
      note:                      'previous active packet demoted; history retained in career_packet table',
    });
  },
});
