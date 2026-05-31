# job_ops-mcp

A self-hosted **Model Context Protocol** server for the full job-search loop — portal
scanning, JD evaluation, tailored resume + cover PDFs, outreach drafting, story bank,
negotiation brief — all driven from your MCP-aware chat client (Claude Desktop, Cursor,
any client that speaks streamable-HTTP MCP).

The chat is the brain. This server executes the mechanical work and hands every artifact
back as an `http://localhost:7891/...` link.

> **Status:** early. Works. APIs may still move pre-1.0.

---

## Quickstart

```bash
# 1. Scaffold your working directory (cv.md, profile.yml, portals.yml + SQLite DB)
npx job_ops-mcp init

# 2. Open cv.md, config/profile.yml, portals.yml and replace every <TODO> placeholder.

# 3. Rebuild the career_packet from your now-real cv.md
#    (or just re-run `init` — it auto-reseeds when it detects cv.md changed)
npx job_ops-mcp reseed

# 4. Confirm everything is wired
npx job_ops-mcp doctor

# 5. Boot the server (Chromium auto-installs on first run)
npx job_ops-mcp start
#  ▷ job_ops-mcp listening on http://127.0.0.1:7891

# 6. Get a copy-paste config block for your MCP client
npx job_ops-mcp connect

# 7. Paste a job URL or pasted JD into your chat — the chat calls evaluate_job, draws on
#    your rubric + career_packet + tailoring rules, and walks the rest of the workflow.
```

That's the loop. Everything else (warm-intro finder, story bank, negotiation brief,
batch rater, scheduler, …) is wired in but optional.

### The edit-cv.md loop

Your `career_packet` is the source of truth the chat uses to score JDs and draft
materials. It's built from `cv.md` + `config/profile.yml`. Whenever you edit `cv.md`,
**re-run reseed** so the chat sees the new bullets:

```bash
# After any edit to cv.md:
npx job_ops-mcp reseed
```

`reseed` writes a NEW active version (the previous version is demoted, history kept).
The chat can also call the `reseed_career_packet` MCP tool to do the same thing without
leaving the conversation. `doctor` warns when `cv.md` changed since the last reseed, and
`init` auto-reseeds when it detects the mismatch.

---

## What it does

Two systems merged into one MCP server:

- **Evaluation + materials side** — port of [santifer/career-ops](https://github.com/santifer/career-ops):
  6-block A–F (+G legitimacy) report, archetype detection, ATS-friendly HTML→PDF resume
  + cover generation, story bank, negotiation playbook.
- **Pipeline side** — port of a personal Postgres + n8n pipeline ("JSA"): Greenhouse /
  Ashby / Lever / Workday pollers + closed-board Playwright scrapers, content-hash
  dedupe, batch LLM rater with strict-JSON parsing, warm-intro / founder DM drafter,
  visa signal from DOL OFLC H1B data.

Everything lives in a single Node process with a single SQLite file. No external
Postgres, no n8n, no cloud anything. Bring your own LLM key (Gemini free tier by
default, DeepSeek optional) if you want the API/batch paths; chat-mode tools work
without one.

> **Not affiliated with or endorsed by santifer's career-ops.** This is an independent
> project that ports + adapts the publicly-released MIT-licensed templates and rubric
> shape into the MCP transport surface. See the [Attribution](#attribution) section.

---

## Tools (36 — one MCP `tools/list` call away)

| Group | Tools |
|---|---|
| **Evaluation** | `evaluate_job`, `batch_evaluate`, `get_top_jobs`, `evaluate_training`, `evaluate_project` |
| **Materials** | `generate_materials`, `render_pdf` (PDF / `.tex` / `.docx`), `get_report` |
| **Tracker** | `get_tracker`, `update_status`, `mark_ready_to_apply` |
| **Sourcing** | `scan_portals` (Greenhouse + Ashby + Lever + Workday + Amazon + Google + generic Playwright) |
| **Outreach** | `find_warm_intros`, `find_founders`, `draft_outreach`, `draft_followup`, `draft_reply`, `get_outreach_queue`, `update_outreach`, `get_followups_due` |
| **Interview / offer** | `extract_stories`, `get_story_bank`, `negotiation_brief` |
| **Research** | `deep_research`, `enrich_company`, `daily_digest` |
| **Profile + ops** | `get_career_packet`, `update_career_packet`, `cost_estimate` |
| **Apply (preview only — never submits)** | `apply_prefill` |
| **Visa (optional, can be hidden)** | `visa_signal`, `import_h1b`, `import_linkedin` |
| **Scheduler (opt-in cron, off by default)** | `scheduler_status`, `scheduler_enable`, `scheduler_disable` |

Six MCP **resources** carry the editable behaviour — rubric, report_format,
tailoring_rules, outreach_tone, negotiation_playbook, career_packet — all loaded from
`modes/*.md` and live-reloaded on edit. Tune scoring or tone without touching code.

---

## Designed to be made yours

The defaults assume nothing about your location, citizenship, role, or industry. Every
behaviour-shaping piece is a markdown file you can rewrite:

| You can change… | By editing… |
|---|---|
| Scoring dimensions + weights | `modes/rubric.md` |
| 6-block report shape | `modes/report_format.md` |
| Resume/cover tailoring rules | `modes/tailoring_rules.md` |
| Outreach tone + char caps | `modes/outreach_tone.md` |
| Negotiation scripts + framework | `modes/negotiation_playbook.md` |
| Your bullet/project bank | `modes/career_packet.md` (or via `update_career_packet`) |
| Tracked companies + filters | `portals.yml` |
| Identity + target roles | `config/profile.yml` |

### Non-US users / non-sponsorship cases

Visa scoring is **fully optional**. Set:

```bash
export MCP_JSA_VISA_SCORING=false
```

When off:

- `score_total = round(0.6 · resume_fit + 0.4 · taste_fit)` (server-side authoritative)
- The `visa_signal`, `import_h1b`, `import_linkedin` tools are hidden from `tools/list`
- `score_visa_fit` is stripped from `get_top_jobs` items and the eval-report HTML badge
- The rubric resource gets a "VISA SCORING DISABLED" override prefix the chat reads

Other features are unaffected. If you're a US citizen, a non-US user, or anyone scoring
roles where sponsorship is a non-issue — turn it off; the rest of the system works.

### Non-US markets

`portals.yml` ships with example shapes for Greenhouse / Ashby / Lever / Workday / Amazon
/ Google / generic Playwright. Drop in the boards relevant to your market. `modes/rubric.md`
+ `modes/negotiation_playbook.md` + `config/profile.yml` are all yours to localize
(language, comp ranges, geography priors).

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `MCP_JSA_PORT` | `7891` | HTTP port (MCP + file server + tracker dashboard) |
| `MCP_JSA_HOST` | `127.0.0.1` | Bind host |
| `MCP_JSA_PROJECT_ROOT` | cwd | Where `cv.md` / `config/profile.yml` / `portals.yml` live |
| `MCP_JSA_DATA_DIR` | `<install>/data` | SQLite + WAL location |
| `MCP_JSA_OUTPUT_DIR` | `<install>/output` | Rendered artifacts (PDFs, report HTML) |
| `MCP_JSA_VISA_SCORING` | `true` | Set `false` to drop visa surface entirely (see above) |
| `MCP_JSA_LLM_PROVIDER` | `gemini` | Used only by `api`/batch paths: `gemini`, `deepseek`, `none` |
| `MCP_JSA_LLM_MODEL` | _empty_ | Provider-specific model id |
| `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` | _empty_ | Provider credentials |
| `MCP_JSA_SCHEDULER_ENABLED` | `false` | Whether opt-in cron runs at all |

A working starter is at `.env.example`.

---

## Wiring it to Claude Desktop (stdio transport)

Claude Desktop's local MCP only speaks **stdio**, not HTTP. Use the `--stdio` flag:

```jsonc
{
  "mcpServers": {
    "job_ops-mcp": {
      "command": "npx",
      "args": ["-y", "job_ops-mcp", "start", "--stdio"],
      "env": {
        "MCP_JSA_PORT": "7891",
        "MCP_JSA_PROJECT_ROOT": "/absolute/path/to/your/job-search/dir"
      }
    }
  }
}
```

(Drop into `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%/Claude/claude_desktop_config.json` on Windows. Restart Claude Desktop.)

In `--stdio` mode the MCP transport rides stdin/stdout (which Claude Desktop drives via
the `npx` spawn); the HTTP file server still binds to `MCP_JSA_PORT` in the background
so the `http://127.0.0.1:7891/files/*` links the server returns continue to resolve in
your browser.

Generic MCP clients that take a streamable-HTTP URL: skip the `--stdio` flag, run
`npx job_ops-mcp start` in a terminal, and point your client at
`http://127.0.0.1:7891/mcp`.

`npx job_ops-mcp connect` prints both blocks ready to paste.

### LibreChat

`npx job_ops-mcp connect` also prints a `librechat.yaml` block. Two shapes:

- **LibreChat as a host process:** `type: streamable-http`, `url: http://127.0.0.1:7891/mcp`.
- **LibreChat in Docker:** swap to `http://host.docker.internal:7891/mcp` AND allowlist
  the address under `mcpSettings.allowedAddresses` (LibreChat blocks private/internal
  addresses by default as SSRF protection). On Linux, also add
  `extra_hosts: ["host.docker.internal:host-gateway"]` to the LibreChat service in your
  `docker-compose.yml`.

(Refs:
[librechat.ai/docs/.../mcp_servers](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers),
[features/mcp](https://www.librechat.ai/docs/features/mcp).)

---

## Working `evaluate_job` payloads

### Step 1 — paste a JD or URL

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "evaluate_job",
    "arguments": {
      "input": "https://jobs.ashbyhq.com/example/123",
      "mode": "chat",
      "title":   "Builder PM",
      "company": "Frontier AI Tools Co"
    }
  }
}
```

Returns the rubric, the report format, the active career packet, and a `job_id`. The
chat client uses those to score + draft the 6 blocks.

### Step 2 — finalize

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "evaluate_job",
    "arguments": {
      "job_id": "<from step 1>",
      "mode": "chat",
      "report": {
        "archetype_detected": "Agentic / LLMOps hybrid",
        "block_role_summary": "…",
        "block_cv_match":     "…",
        "block_level":        "…",
        "block_comp":         "…",
        "block_personalize":  "…",
        "block_interview":    "…",
        "block_legitimacy":   "…",
        "keywords":           ["builder pm", "agentic workflows", "…"]
      },
      "scores": {
        "resume_fit": 86, "taste_fit": 92, "visa_fit": 88, "score_total": 88,
        "reasoning": "Strong match on agentic workflows + PRDs + SQL/Python.",
        "concerns":  "Evals experience is adjacent rather than LLM-eval-specific.",
        "role_category": "pm",
        "seniority":     "senior"
      }
    }
  }
}
```

Server persists, renders HTML at `/files/reports/<id>.html`, returns the URL.

---

## Downloadable, editable source formats

`render_pdf` produces the resume and cover in any subset of three formats:

| Format | Where it lands  | Use it for                                                    |
|--------|-----------------|---------------------------------------------------------------|
| `pdf`  | `/files/pdfs/`  | The deliverable. Light/white background, ATS-clean.           |
| `tex`  | `/files/tex/`   | The editable LaTeX source. Compiles with vanilla `pdflatex`.  |
| `docx` | `/files/docx/`  | Word / Google Docs editing. Real headings + bullets, ATS-safe. |

Default is `formats: ["pdf"]` for back-compat. Request any subset:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "render_pdf",
    "arguments": {
      "job_id": "<from evaluate_job>",
      "kind":    "both",
      "formats": ["pdf", "tex", "docx"],
      "cover_body": "I am reaching out about ..."
    }
  }
}
```

All URLs persist onto the application row in the `rendered_files` JSON column so
`get_tracker`, `apply_prefill`, and `daily_digest` can find them later. Re-rendering
one format merges into the existing map — never clobbers the others.

The `.tex` and `.docx` are built from the same parsed `cv.md` and `cover_body` the
PDF uses, so editing and recompiling the `.tex` reproduces the same document. The
visa-leakage rail runs against every output format before files are written.

---

## Advanced / outreach features (optional)

### Importing your LinkedIn network → warm-intro finder

Download your LinkedIn data export (Settings → Data Privacy → Get a copy of your data →
Connections), then:

```bash
# Through your MCP chat:
import_linkedin path="/absolute/path/to/Connections.csv"
```

Now `find_warm_intros(company="…")` returns the people you actually know who work there
(filtered to non-recruiters, sorted by engineering / leadership weight).

### Importing DOL OFLC H1B data → visa-friendliness signal

Download a quarterly LCA disclosure CSV from <https://www.dol.gov/agencies/eta/foreign-labor/performance>,
then:

```bash
# Through your MCP chat:
import_h1b path="/absolute/path/to/LCA_Disclosure_Data_FY2025_Q1.csv"
```

`visa_signal(company="…")` then returns a friendliness band (`strong | mixed | weak |
none`) computed from filings count + recency. **Internal only** — never surfaced in any
resume, cover letter, or outreach (see the visa hard rule).

If you disabled visa scoring (`MCP_JSA_VISA_SCORING=false`), these tools don't appear in
`tools/list` at all.

### Scheduler (opt-in cron)

Off by default. To run scans + batch rates on a schedule:

```bash
# In your MCP chat:
scheduler_enable jobs=["scan_portals_4h", "batch_evaluate_30m", "daily_digest_morning"]
```

Job cadence is fixed (4h / 30m / hourly with an 8AM digest window). Toggle off with
`scheduler_disable`. Survives only as long as the server process is alive.

---

## Hard rules baked in

1. **Never surface visa / work-auth** in any resume, cover letter, or outreach. Visa data
   is internal scoring only.
2. **Never invent claims** not in `career_packet`. The materials generator validates LLM
   output against the packet before persisting.
3. **Human-in-the-loop everywhere.** No tool auto-submits an application or auto-sends a
   DM. `apply_prefill` is preview-only — it opens the form in Chromium, drafts values,
   takes a screenshot, and stops. You submit manually.
4. **Strict-JSON parsing on the api path** with a recorded `PARSE_ERROR` fallback —
   never silent zeros.
5. **Tracker / application / outreach writes are serialized** behind a single write lock.

---

## Layout

```
job_ops-mcp/
├── modes/                     # MCP resources (edit me to tune the brain)
├── templates/                 # CV HTML/LaTeX templates + cover-letter template
├── fonts/                     # Space Grotesk, DM Sans (woff2 subsets)
├── cv.example.md              # → cv.md after init
├── config/profile.example.yml # → config/profile.yml after init
├── portals.example.yml        # → portals.yml after init
├── src/                       # TypeScript source (not published)
│   ├── cli.ts                 # init / start / doctor / connect
│   ├── server.ts              # HTTP + MCP boot
│   ├── core/                  # llm, providers, jobs, reports, render, scan_engine, …
│   ├── http/                  # express app + dashboard
│   ├── mcp/                   # define + register + tools/
│   └── migrations/*.sql       # SQLite migrations
└── data/, output/             # gitignored runtime state
```

---

## Attribution

- The HTML CV template, font set, and ATS unicode-normalization logic are ported from
  [santifer/career-ops](https://github.com/santifer/career-ops) (MIT licensed). The
  6-block A–F report shape, scoring rubric framing, and outreach tone rules are also
  inspired by that project. **Not affiliated with or endorsed by career-ops** — this is
  an independent fork of those publicly-released ideas into the MCP transport.
- The 3-dimension scoring formula (resume / taste / visa), the schema shape
  (companies / jobs / outreach / enrichment / career_packet views), and the strict-JSON
  rater rubric are distilled from a personal pipeline ("JSA") that predates this
  project.

---

## Releasing (maintainer notes)

Releases ship to npm via the GitHub Actions workflow at
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). The workflow fires
**only on pushing a version tag** (`v*.*.*`) — never on a push to `main` — so merging
work never auto-publishes.

### One-time setup

1. **Generate an npm automation token** at [npmjs.com](https://www.npmjs.com/) →
   click your avatar → **Access Tokens** → **Generate New Token** → choose
   **"Automation"** (NOT *Read-Only* and NOT *Publish*; Automation tokens bypass 2FA,
   which CI needs).
2. **Add it to GitHub.** In the repo → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret** → name **`NPM_TOKEN`**, value the token
   you just copied (starts with `npm_`).

### Cutting a release

```bash
# 1. Bump the version in package.json. Either edit by hand, or:
npm version patch      # 0.3.0 → 0.3.1 (also creates a git commit + tag)
# npm version minor    # 0.3.0 → 0.4.0
# npm version major    # 0.3.0 → 1.0.0

# 2. If you edited package.json by hand instead of `npm version`, commit it:
# git add package.json && git commit -m "release: vX.Y.Z"
# git tag vX.Y.Z

# 3. Push the commit + tag.
git push && git push origin vX.Y.Z
```

That tag push triggers `publish.yml`, which:

1. Checks out the tagged commit.
2. Sets up Node 20 with the npm registry.
3. Verifies the tag (`vX.Y.Z`) matches `package.json`'s `version` — fails fast on a typo.
4. `npm ci` + `npm run build`.
5. `npm publish --access public --provenance` — provenance attaches a sigstore
   attestation visible on npmjs.com showing exactly which GitHub Actions run produced
   the tarball.

Watch progress in the repo's **Actions** tab. On success the new version appears on
[npmjs.com/package/job_ops-mcp](https://www.npmjs.com/package/job_ops-mcp).

## Contributing / feedback

Issues + PRs welcome. There's no contributor guide yet — open an issue first if you're
planning a large change.

---

MIT — see [LICENSE](./LICENSE).
