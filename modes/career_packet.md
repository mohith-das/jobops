# Career Packet

This file is the **active career packet** — the superset of every claim the candidate is
allowed to make. `generate_materials(job_id)` picks subsets from this per JD; it never
invents claims outside this set.

When you run `npx @mohith_das/jobops init` the server seeds this from your `cv.md` +
`config/profile.yml` and stores versioned copies in the `career_packet` table. Re-edit
`cv.md`, then call the `update_career_packet` MCP tool to bump a new version.

This file is also exposed as the `jobops://career_packet/active` MCP resource so the
chat can reason against it directly without round-tripping through the DB.

> **Source of truth — avoid packet drift.** The active packet in the DB is *runtime state*.
> `cv.md` + `config/profile.yml` (+ this template) are the *source of truth*. Edit those and
> run `reseed_career_packet` — do NOT hand-edit Sections 1–8 in the DB packet, because the
> next reseed regenerates them from the source files and silently drops DB-only edits.
> Identity/links/taglines → `config/profile.yml`; experience/projects/skills/education →
> `cv.md`; standing policy that isn't a CV field → this template's Section 9 (preserved
> across reseeds).

> **Note:** the headings below are a **template**. After `init` the server replaces
> Section 1 (identity) from `config/profile.yml` and leaves the rest of the file as
> editable scaffold. Replace the TODO markers with bullets pulled from your own CV — keep
> them concrete (verbs + metrics) and never list anything you can't defend in an interview.

---

## 1. Identity

(seeded from `config/profile.yml` → `candidate` block on server start)

## 2. Tagline alternatives

The job rater picks ONE based on detected `role_category`. Write 4–6 variants — one per
role archetype you target. Example shape:

- **A. Default generalist** — "<one-line positioning that works across all your target roles>"
- **B. ML / Applied AI Engineer** — "<role-specific tagline emphasizing your AI/ML credibility marker>"
- **C. Forward Deployed / Solutions** — "<tagline emphasizing customer-facing delivery>"
- **D. Builder PM / Technical PM** — "<tagline emphasizing PM scope + technical depth>"
- **E. Data / Analytics Engineer** — "<tagline emphasizing data/infra ownership>"
- **F. Generalist SWE / lean teams** — "<tagline emphasizing range and shipping speed>"

## 3. Most recent role — bullet bank (5–8 to pick from)

Source: `cv.md` work-experience section. One sentence per bullet, action-verb start,
~15–25 words, real metrics from your CV.

- <TODO bullet 1 — what you owned, the metric you moved>
- <TODO bullet 2>
- <TODO bullet 3>
- <TODO bullet 4>
- <TODO bullet 5>

## 4. Previous role — bullet bank (3–5 to pick from)

- <TODO bullet 1>
- <TODO bullet 2>
- <TODO bullet 3>

## 5. Earlier role(s) — bullet bank (2–4 to pick from)

- <TODO bullet 1>
- <TODO bullet 2>

> If you have more than three jobs worth highlighting, add new sections (`## 6. ...`) in
> the same shape. `generate_materials` will pick subsets per JD; only the bullets in this
> packet are eligible for the tailored resume.

## 6. Projects bank (pick 2–3 per resume)

- **<Project name>** — <one-sentence description with the credibility marker and stack>.
  Link or GitHub if public.
- **<Project name>** — <description>.
- **<Project name>** — <description>.

## 7. Skills bank (categorized — reorder per JD)

- **AI / LLM Systems:** <list the tools / frameworks / paradigms you can defend>
- **Data & Analytics Engineering:** <SQL flavours, warehouses, ETL, libs>
- **Infrastructure & DevOps:** <containers, clouds, networks>
- **Product:** <PRDs, frameworks, processes>
- **Web & Tools:** <stacks, no-code, design>
- **Languages:** <primary first>

## 8. Education

- **<Degree>** — <Institution> (<year range>). <optional 1-line context>

## 9. Hard rules

- **Never invent metrics.** Only numbers that already appear here or in `cv.md` are usable.
- **Never surface visa / work-auth** in any resume bullet, cover letter, or outreach DM.
  Visa data is internal scoring only — and the whole visa surface can be disabled via
  `JOBOPS_VISA_SCORING=false` if it doesn't apply to you.
- **Never use cliché phrases** ("passionate about", "leveraged", "spearheaded",
  "facilitated", "synergies", "robust", "seamless", "cutting-edge", "innovative",
  "results-oriented", "proven track record").
- **Edit at the source, not in the packet.** Identity/links/taglines live in
  `config/profile.yml`; experience/projects/skills/education live in `cv.md`. Change those
  and reseed. Add any standing policy that has no CV/profile field (naming conventions,
  rendering/escaping rules, custom guardrails) here in Section 9 — reseed preserves it.
