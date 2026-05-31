# Evaluation Report Format

When `evaluate_job(input, mode="chat")` returns the rubric + normalized JD, you (the chat
client) write the 6-block report below and POST it back. The server persists it to
`eval_reports`, renders an HTML view, and returns a localhost link.

Keep blocks tight — the report is for *you* to act on, not a deliverable.

## Block A — Role Summary

Single table:

| Field            | Value                                                  |
|------------------|--------------------------------------------------------|
| Archetype        | one of the 6, or hybrid (e.g. "Agentic / FDE")         |
| Domain           | platform / agentic / LLMOps / ML / enterprise          |
| Function         | build / consult / manage / deploy                      |
| Seniority        | intern → principal                                     |
| Remote           | full / hybrid / onsite                                 |
| Team size        | if mentioned                                           |
| TL;DR            | 1 sentence                                             |

## Block B — CV Match

Table: each JD requirement → exact line(s) in `cv.md`. Then a **Gaps** subsection with one
row per gap: hard blocker vs nice-to-have, adjacent experience the candidate has, mitigation
phrase for the cover letter.

## Block C — Level Strategy

1. **Level detected in the JD** vs **candidate's natural level for that archetype**
2. **"Sell senior without lying" plan** — concrete phrases, achievements to highlight,
   how to frame your most senior-shaped experience (PRD ownership, team lead, end-to-end
   delivery) as senior-equivalent scope
3. **"If they downlevel me" plan** — accept if comp is fair, negotiate 6-month review, clear
   promotion criteria

## Block D — Comp & Demand

Table with market data (Glassdoor / Levels.fyi / Blind / news) + cited URLs. Pull from
`enrichment` table for that company when `kind = 'comp'` exists. If no data, state that
rather than inventing numbers.

## Block E — Personalization Plan

Top 5 changes to CV + top 5 changes to LinkedIn to maximize match. Table:

| # | Section | Current | Proposed | Why |
|---|---------|---------|----------|-----|

## Block F — Interview Plan

6–10 STAR + Reflection stories mapped to JD requirements. Table:

| # | JD requirement | Story title | S | T | A | R | Reflection |
|---|----------------|-------------|---|---|---|---|------------|

Append new stories to `story_bank` via `extract_stories(job_id)`. Over time the bank holds
5–10 master stories you adapt per interview.

Also include:
- 1 case study (which project to present, framed for this role)
- Red-flag questions and how to answer them ("why did you sell your company?",
  "do you have direct reports?")

## Block G — Posting Legitimacy (optional, career-ops parity)

Three tiers: **High Confidence** / **Proceed with Caution** / **Suspicious**. Signals:

- Posting age (under 30d good, 30–60 mixed, 60+ concerning — adjusted for role type)
- Apply button active
- Tech specificity vs boilerplate ratio
- Internal contradictions (entry-level title + staff requirements)
- Recent layoff news
- Reposting pattern (same role 2+ times in 90 days)
- Salary transparency (low-reliability signal)

Present observations, not accusations. Every signal has legitimate explanations.

## Keywords

15–20 keywords from the JD for ATS optimization — verbatim phrases the future tailored
resume should preserve.
