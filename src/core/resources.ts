// Loads the markdown files in modes/ as MCP resources.
//
// Chat clients READ these to do the actual reasoning (scoring, drafting). The server is
// deliberately not the brain — it just hands these documents over so the chat stays
// aligned with the rubric + tone rules every turn.

import { getActiveCareerPacket } from './profile.js';
import { getMode } from './modes.js';

export interface ModeResource {
  uri:         string;     // e.g. mcp-jsa://modes/rubric
  name:        string;
  title:       string;
  mimeType:    string;
  description: string;
  body:        () => string;
}

export function listResources(): ModeResource[] {
  return [
    fileResource('rubric',               'Rating Rubric',          'How to score a job (resume / taste / visa fit, weights, hard rules).'),
    fileResource('report_format',        'Evaluation Report Format','6-block A–F (+G) report shape that chat fills in.'),
    fileResource('tailoring_rules',      'Materials Tailoring Rules','How generate_materials picks bullets/projects per JD.'),
    fileResource('outreach_tone',        'Outreach Tone',           'Warm-intro + founder DM rules (char caps, never-refer-me, etc.).'),
    fileResource('negotiation_playbook', 'Negotiation Playbook',    'Scripts + frames for negotiation_brief.'),
    {
      uri:  'mcp-jsa://career_packet/active',
      name: 'career_packet',
      title: 'Active Career Packet',
      mimeType: 'text/markdown',
      description: 'The active, versioned superset of every claim the candidate may make. Seeded from cv.md + modes/career_packet.md.',
      body: () => {
        const row = getActiveCareerPacket();
        return row?.content ?? '_no active career packet — start the server once to seed_';
      },
    },
  ];
}

function fileResource(slug: string, title: string, description: string): ModeResource {
  // Go through getMode() so dynamic prefixes (e.g. the VISA SCORING DISABLED block
  // applied to rubric.md when MCP_JSA_VISA_SCORING=false) reach the chat too.
  return {
    uri:  `mcp-jsa://modes/${slug}`,
    name: slug,
    title,
    mimeType: 'text/markdown',
    description,
    body: () => getMode(`${slug}.md`),
  };
}
