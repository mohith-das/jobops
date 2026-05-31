# Rating Rubric

Distilled from career-ops' scoring system + the JSA-style three-dimension formula. Edit
this file to retune scoring; the MCP server loads it at runtime and serves it as a
resource to the chat.

> **Visa scoring is optional.** Set `MCP_JSA_VISA_SCORING=false` to drop `visa_fit` from
> the formula and switch to renormalized weights (`resume 0.6 + taste 0.4`). When disabled,
> the server prepends an override block to the top of this rubric, hides the visa-related
> tools (`visa_signal`, `import_h1b`, `import_linkedin`), and strips visa columns from
> tool responses. If sponsorship is irrelevant to you (US citizen, non-US user, etc.),
> turn it off and use the 2-dimension form.

## About the candidate

The candidate's identity, experience summary, target roles, and constraints live in
`config/profile.yml` (seeded by `init`) and the active `career_packet`. **Read those
before scoring** — every dimension is judged against the candidate's actual background,
not a hypothetical average applicant.

## Role priority order

Defined in `config/profile.yml` → `target_roles.archetypes`. Each archetype has a `fit`
band:

- **primary** — dream role; you'd take it tomorrow at the right comp
- **secondary** — good fit; you'd take it if the company is right
- **adjacent** — stretch; you'd consider it if the rest is excellent

If a job clearly maps to one of the listed archetypes, set `role_category` accordingly:
`pm | ml_eng | data_eng | analytics_eng | swe | forward_deployed | other`.

**Archetype override:** if the user has set `declared_archetype` on a job, use that
instead of inferring `role_category` — it represents an explicit preference and wins.

## Rating dimensions (each 0–100)

### `resume_fit` — how well does the candidate's background match the role's stated requirements?

- 90+ excellent match
- 70–89 strong match with some gaps
- 50–69 stretch but not absurd
- <50 role wants very different background

### `taste_fit` — does this role match what excites the candidate?

Compare the JD against `config/profile.yml` → `narrative.likes` and
`narrative.dislikes`, plus the active career_packet's positioning.

- 90+ role + company strongly match preferences
- 70–89 good match
- 50–69 neutral
- <50 conflicts with stated dislikes

### `visa_fit` — will this company / role work for someone who needs visa sponsorship?

Only applied when `MCP_JSA_VISA_SCORING=true`. Pull from:

- The job description itself (mentions of sponsorship, work authorization, citizenship)
- The company's H1B record via `visa_signal(company)` (requires `import_h1b` to have been
  run with a DOL OFLC CSV)
- The candidate's situation in `config/profile.yml` → `location.visa_status`

Scoring:

- 90+ company actively sponsors, role is standard FTE
- 70–89 company sponsors but role unclear
- 50–69 unknown sponsorship, small company, no clear signal
- <50 contract role / US-citizens only / no-sponsor / region-locked away from candidate

### `score_total` — weighted

When visa scoring is **on**:

```
round( 0.5 * resume_fit + 0.3 * taste_fit + 0.2 * visa_fit )
```

When visa scoring is **off** (the server enforces this server-side too, regardless of
what the chat returns):

```
round( 0.6 * resume_fit + 0.4 * taste_fit )
```

Tier shorthand: A ≥ 85, B 75–84, C 60–74, D 40–59, F < 40.

## Output contract (chat mode)

When the chat client returns scores via `evaluate_job` it MUST emit STRICT JSON:

```json
{
  "resume_fit": 0,
  "taste_fit": 0,
  "visa_fit": 0,
  "score_total": 0,
  "reasoning":   "2–3 sentences on main fit signal",
  "concerns":    "1–2 sentences on biggest concerns, or null",
  "role_category": "pm | ml_eng | data_eng | analytics_eng | swe | forward_deployed | other",
  "seniority":     "intern | junior | mid | senior | staff | principal | lead | unclear"
}
```

(When `MCP_JSA_VISA_SCORING=false`, omit `visa_fit` — see the override block the server
prepends.)

If you cannot parse or anything is uncertain, leave `concerns` populated and set
`role_category: "other"` / `seniority: "unclear"` — never silent zeros.

## Hard rules (NEVER violate)

1. **Never surface visa / work-auth in any resume, cover letter, or outreach.** Visa data
   is internal scoring (`visa_fit`) and `visa_signal` only.
2. **Never invent claims** not present in the career_packet / cv.md.
3. **Human-in-the-loop everywhere** — no tool auto-submits an application or auto-sends a
   DM. `apply_prefill` is preview-only.
4. **Strict-JSON parsing on the api path.** On parse failure, record a `PARSE_ERROR` in
   `score_detail` — never silently default to zeros.
