# Tailoring Rules

Distilled from career-ops + JSA materials generation. Used by
`generate_materials(job_id)` to pick bullets/tagline/projects from the active career
packet per JD.

## Input

You receive:
1. The full **career packet** (superset of every claim the candidate is allowed to make)
2. The **JD** (title, description, requirements)
3. The detected **role_category** (or `declared_archetype` if the user set one)
4. Optional **enrichment summaries** (comp, culture, recent_news)

## Output contract (STRICT JSON)

`experience_bullets` is keyed by a slug per employer / role from your career packet
(e.g. `current_role`, `previous_role`, or whatever short employer slugs you used in
your own packet). Use the same keys your packet uses; the renderer reads them by name.

```json
{
  "tagline":            "from career packet section 2, pick the most appropriate alternative",
  "experience_bullets": {
    "<employer_slug_a>": ["\\resumeItem-wrapped bullet", "...5-8 bullets..."],
    "<employer_slug_b>": ["...3-5 bullets..."],
    "<employer_slug_c>": ["...2-4 bullets..."]
  },
  "projects_section": "full LaTeX string with 2-3 project headings",
  "skills_section":   "LaTeX string with reordered \\item categories",
  "cover_letter_body": "250-350 words plain prose, NO latex",
  "tailoring_notes":  "why you picked these specific bullets/projects"
}
```

## Tailoring decisions by role type

Pick the tagline + the experience emphasis + the project order + the skills order based
on `role_category`. The exact lead bullets depend on what's in *your* packet — the
guidance below is about *which dimensions to surface*, not specific projects.

| `role_category`              | Tagline option | Lead with                                          | Skills order                                       |
|------------------------------|----------------|----------------------------------------------------|----------------------------------------------------|
| `ml_eng` / Applied AI        | B              | AI / agent / model work; tool-calling pipelines    | AI/LLM → Data Science → Stacks → Product → Infra   |
| `forward_deployed`           | C              | Customer-facing delivery; shipped enterprise wins  | AI/LLM → Product → Stacks → Infra                  |
| `pm`                         | D              | Product ownership; PRDs; cross-functional leadership| Product → AI/LLM → Data Science → Infra            |
| `data_eng` / `analytics_eng` | E              | Pipeline + warehouse + observability work          | Data Science → Infra → AI/LLM → Stacks             |
| `swe` (generalist, lean)     | default A or F | Full-stack shipping evidence                       | Stacks → AI/LLM → Infra → Data Science             |
| `other`                      | default        | Mirror highest-fit role from the table             | Product → AI/LLM → Data Science                    |

## Bullet formatting (CRITICAL)

- Wrap every bullet exactly: `\resumeItem{...}` (in JSON: `\\resumeItem{...}`)
- Bold 1–3 things per bullet with `\textbf{...}` — tools, metrics, key claims
- Escape LaTeX specials inside bullet text: `&` → `\&`, `%` → `\%`, `$` → `\$`,
  `#` → `\#`, `_` → `\_`
- One sentence, ~15–25 words, action-verb start
- **Use only metrics that appear in the career packet / cv.md.** DO NOT invent numbers.

## Projects section

Build a complete LaTeX `\resumeProjectHeading` block. 2–3 projects total, 2–4 bullets each.
Format:

```latex
\resumeProjectHeading
  {\textbf{<project name>} --- <short description> $|$ \href{<url>}{<display>}}{<years>}
  \resumeItemListStart
    \resumeItem{<bullet emphasising the credibility marker for this project>}
    \resumeItem{...}
  \resumeItemListEnd
```

## Skills section

```latex
\item \textbf{AI / LLM Systems:} <comma-separated list ordered by JD relevance>
\item \textbf{Data Science & Engg.:} <list>
\item \textbf{Product:} <list>
\item \textbf{Infra & DevOps:} <list>
\item \textbf{Stacks & Tech:} <list>
```

Pick which categories to include + their order based on JD relevance.

## Cover letter rules

- 250–350 words, plain prose, **NO LaTeX commands at all**
- Open with ONE specific observation about the company / product pulled from the JD
- Mid: connect 1–2 candidate projects/experiences to the role's needs
- Close: state interest as a conversation — substantive, not "looking forward"
- No "I am writing to apply for ..."
- No exclamation points, no emojis
- **DO NOT mention work authorization / EAD / visa / sponsorship**
- Optional: one unexpected detail per cover letter (a side project, a non-obvious angle on
  the role)

## Tailoring notes

In `tailoring_notes`, explain in 2–3 sentences:
- Why you picked these specific bullets/projects (which JD signals they match)
- What you deliberately left out and why
