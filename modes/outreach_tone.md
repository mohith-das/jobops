# Outreach Tone

Distilled from JSA study guide §4.4 (Warm Outreach) + §4.5 (Founder Outreach).

## Hard rules — apply to every outreach draft

- **No emojis. No exclamation marks.** No "I hope this finds you well." No "I'd love to
  pick your brain."
- **No mention** of work authorization, EAD, OPT, visa, sponsorship, or anything legal.
  The play is relationship now, action later.
- **Never ask "refer me"** or "can you put my resume in front of someone."
- **Soft close.** End with "no worries if not a fit" (warm) or "no worries if too busy /
  genuinely curious / happy to be ignored" (founder).
- Lowercase casual fine. Native tech English. Short sentences, action verbs.

## Warm intro DM (existing LinkedIn connection at the company)

| Constraint     | Value                                                        |
|----------------|--------------------------------------------------------------|
| Character cap  | **< 600 chars total (hard limit)**                           |
| Lead           | ONE specific thing about *their* work, company, or role they hold — NOT a generic compliment |
| Ask            | Make it SMALL: a 15-minute chat, a curious question about the team, or how they got into [role] |
| Persona        | Peer / builder, NOT job seeker — drop one tiny credibility marker from your career_packet (a side project, a shipped product, a public artifact — keep it under 10 words) |
| Close          | "no worries if not a fit"                                    |

**Variants by connection type:**

- **Engineering peer** → curious technical question about the team / stack
- **Recruiter** → slightly more direct ("curious if there is still room in [role]") but
  still no "refer me"
- **Leadership** → one thoughtful question about how they're thinking about
  [team/space] — make them want to reply

## Founder DM (peer-to-peer, non-stealth founder/CEO/CTO/c-suite)

| Constraint     | Value                                                        |
|----------------|--------------------------------------------------------------|
| Character cap  | **< 300 chars total (hard limit — shorter than warm)**       |
| Lead           | "saw you're building {resolved_company or company_raw}" + ONE specific, curious, technical question about what they're working on (architecture choice, the wedge, the GTM) |
| Bridge         | Drop ONE adjacent candidate project (1 short phrase): "I've been building X, curious how y'all approach Z" |
| Persona        | Peer with adjacent project — NOT looking for a job           |
| Close          | "no worries if too busy" or "genuinely curious / happy to be ignored" |

**Adjacent project bank** — populate from `career_packet.md` section 6. Each entry should
be one short phrase you could drop into a 300-char DM. Example shape:

1. **<Project name>** — <one-line credibility marker>. Useful when their company is
   <domain X / Y / Z>.
2. **<Project name>** — <one-line>. Useful when <domain>.
3. **<Project name>** — <one-line>. Useful when <domain>.

**Forbidden moves:**

- NOT a job ask. NO "I'm looking for a job", NO "are you hiring", NO "refer me".

## Followup DM (sent-but-unanswered after N days)

1–2 line nudge. NO new ask. Tone: "still curious about X — drop me a line if it ever makes
sense." Soft close again. No guilt.

## Reply draft (someone replied — chat now drafts the human's response)

Match their energy. If they replied warmly with a question, answer it tightly and add one
forward-moving piece (link to a project, a specific time window for a chat). If they
deflected politely, send 1-line thanks + an open door ("happy to come back if anything
opens up — no pressure either way"). Never beg.

## Output contract (chat / api)

When drafting, return STRICT JSON:

```json
{
  "message":      "the full DM, within the char cap, no emojis",
  "opening_hook": "the specific thing you led with, 1 sentence",
  "primary_ask":  "what you actually asked them to do, 1 short phrase",
  "strategy_note": "1-2 sentence note on why this framing should work for this contact",
  "subject_line":  "email subject if channel=email, else 1-line placeholder"
}
```
