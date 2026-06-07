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
# 1. Scaffold your working directory (cv.md, profile.yml, portals.yml, modes/*.md + SQLite DB)
npx job_ops-mcp init

# 2. Open cv.md, config/profile.yml, portals.yml and replace every <TODO> placeholder.
#    (Optional: tune modes/*.md — rubric, tailoring rules, outreach tone — your edits win.)

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

### Editing the career packet — two safe directions

Your `career_packet` is the source of truth the chat uses to score JDs and draft materials.
You can drive edits from **either** direction, and **neither one silently destroys the
other** — both are explicit:

**1. Chat-driven (the packet is your edit surface).** Ask the chat to change a tagline,
remove a project, tighten a bullet — it calls `update_career_packet`, which writes a new
version and **marks the packet user-edited**. From then on a plain `reseed` will **refuse**
to overwrite it (it warns and tells you to pass `force` or sync first). Section edits are
ergonomic — "change my tagline" only re-sends Section 2, not the whole packet:

```text
update_career_packet section="2" section_content='- **Builder PM** — "ships product with engineering teeth"'
```

**2. File-driven (cv.md / profile.yml are the source).** Edit `cv.md` /
`config/profile.yml`, then **reseed** to rebuild the packet from them:

```bash
npx job_ops-mcp reseed            # safe: refuses if the packet has chat edits not in cv.md
npx job_ops-mcp reseed --force    # rebuild from cv.md anyway (drops chat edits)
```

**Bringing the two back in sync.** When you've been editing in chat and want `cv.md` to
catch up, run `sync_packet_to_cv` — it writes the packet back into `cv.md` + `profile.yml`
so the source files reflect your chat edits (and a later `reseed` reproduces them instead of
clobbering them). So the two directions are symmetric: **reseed** (cv.md → packet) and
**sync-back** (packet → cv.md), both explicit, neither automatic.

`reseed` writes a NEW active version (previous demoted, history kept). `doctor` reports when
the packet is chat-edited (expected — not a nag) vs when `cv.md` changed under a file-driven
packet. Standing policy with no CV/profile field (naming conventions, rendering rules, custom
guardrails) lives in `modes/career_packet.md` Section 9, which reseed always preserves.

> **Operator's guide / project memory:** [`docs/PROJECT_MEMORY.md`](docs/PROJECT_MEMORY.md)
> is a single self-contained reference (architecture, every tool, env vars, setup, the
> template system, sampling/elicitation/auth, hard rules, troubleshooting). Drop it into your
> MCP client's project memory so you can ask "how do I X?" and get answers.

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

## Tools (41 — one MCP `tools/list` call away)

| Group | Tools |
|---|---|
| **Evaluation** | `evaluate_job`, `batch_evaluate`, `get_top_jobs`, `evaluate_training`, `evaluate_project` |
| **Materials** | `generate_materials`, `render_pdf` (PDF / `.tex` / `.docx`), `get_report` |
| **Tracker** | `get_tracker`, `update_status`, `mark_ready_to_apply` |
| **Sourcing** | `scan_portals` (Greenhouse + Ashby + Lever + Workday + Amazon + Google + generic Playwright) |
| **Outreach** | `find_warm_intros`, `find_founders`, `add_contacts` (insert/update network contacts from chat), `draft_outreach`, `draft_followup`, `draft_reply`, `get_outreach_queue`, `update_outreach`, `get_followups_due` |
| **Interview / offer** | `extract_stories`, `get_story_bank`, `negotiation_brief` |
| **Research** | `deep_research`, `enrich_company`, `daily_digest` |
| **Profile + ops** | `get_career_packet`, `update_career_packet` (chat edits, section-level), `reseed_career_packet` (safe by default), `sync_packet_to_cv` (packet → cv.md), `update_profile` (elicitation), `cost_estimate`, `doctor` (read-only health report) |
| **Apply (preview only — never submits)** | `apply_prefill` |
| **Visa (optional, can be hidden)** | `visa_signal`, `import_h1b`, `import_linkedin` |
| **Scheduler (opt-in cron, off by default)** | `scheduler_status`, `scheduler_enable`, `scheduler_disable` |

Six MCP **resources** carry the editable behaviour — rubric, report_format,
tailoring_rules, outreach_tone, negotiation_playbook, career_packet — all loaded from
`modes/*.md` and live-reloaded on edit. Tune scoring or tone without touching code.

> **Tip:** ask the chat to run **`doctor`** anytime — it's a read-only health report (same
> checks as the `npx job_ops-mcp doctor` CLI command) covering packet ↔ cv.md sync state,
> LLM provider/key, sampling + auth posture, active template, modes, visa scoring, and the
> public base URL. Handy for "is my server wired right?" without leaving chat.

---

## Scoring without an LLM key — IF your client supports MCP sampling

The scoring tools (`batch_evaluate`, `evaluate_job` `mode="api"`) can run on your
*connected client's model* via **MCP sampling** — same rubric, same strict-JSON contract,
**no separate Gemini/DeepSeek key** — **but only if the connected client advertises the
`sampling` capability** in its initialize handshake.

> ⚠️ **Most clients don't (yet) — including Claude Desktop, as of now.** Claude Desktop
> advertises only its UI extension, never `sampling`. The transport (stdio vs HTTP) is **not**
> sufficient on its own — it's a per-client *capability*. So on Claude Desktop and similar
> clients, batch/api scoring **falls back to the BYO key** (`MCP_JSA_LLM_PROVIDER` + key),
> which is expected and correct. Check current support at
> [modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients).

- **It engages automatically if (and only if) a sampling-capable client connects** — no
  configuration needed. The gate checks both the client's advertised `sampling` capability
  **and** that the transport can carry the server→client request (stdio; the stateless HTTP
  transport can't, so it never even tries). When sampling isn't available, scoring uses the
  BYO key; if that isn't set either, `evaluate_job mode="chat"` (the default) still works —
  your chat scores it directly. Fallback is clean (no hang).
- **Bottom line for Claude Desktop users:** set `MCP_JSA_LLM_PROVIDER` + the matching key
  for `batch_evaluate` / `evaluate_job mode="api"`. (Plain `mode="chat"` needs no key.)
- **Cost.** When sampling *is* used it runs on the client's model, so the cost is **borne by
  the client**; `cost_estimate` records those calls flagged client-borne ($0 server cost).
- Run the `doctor` tool to see the **live** state — it reports whether your current client
  advertised sampling or whether you're on the BYO-key path.
- Set `MCP_JSA_SAMPLING=false` to force the BYO-key path even when sampling is available.

## Frictionless profile setup (MCP elicitation)

`update_profile` uses **MCP elicitation** (form mode) so your client can collect identity
fields + per-archetype taglines through a structured form — no hand-editing YAML. On
accept it writes `config/profile.yml` and reseeds the career packet in one step.

Sensitive inputs (your LinkedIn export path, credentials) use **URL-mode elicitation**
(2025-11-25): the server hands you a one-time local URL where you enter the value
directly, so it **never passes through the MCP client / chat transcript**. `import_linkedin`
uses this when you omit `path` and your client supports it.

Both are capability- and transport-gated (like sampling, elicitation is a server→client
request that needs a stdio connection). Clients without elicitation support — and all HTTP
clients — fall back to the file-based + argument paths (`update_profile fields=…`, edit
`config/profile.yml`, pass `import_linkedin path=…`), which work exactly as before.

---

## Designed to be made yours

The defaults assume nothing about your location, citizenship, role, or industry. Every
behaviour-shaping piece is a markdown file you can rewrite. **`init` copies these into
`<project-root>/modes/` so they're yours to edit** — the loader reads your project-root
copy first and falls back to the bundled default, so you never touch the package install.
A re-`init` never clobbers an edited copy (it warns and keeps your edits); `doctor` reports
which files are user-overridden vs bundled.

| You can change… | By editing… |
|---|---|
| Scoring dimensions + weights | `modes/rubric.md` |
| 6-block report shape | `modes/report_format.md` |
| Resume/cover tailoring rules | `modes/tailoring_rules.md` |
| Outreach tone + char caps | `modes/outreach_tone.md` |
| Negotiation scripts + framework | `modes/negotiation_playbook.md` |
| Your bullet/project bank | `modes/career_packet.md` (or via `update_career_packet`) |
| Per-archetype taglines | `config/profile.yml` → `taglines:` (auto-fills career-packet Section 2 on reseed) |
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
| `MCP_JSA_TEMPLATE_DIR` | _empty_ | User-owned dir holding additional resume/cover themes — overrides bundled themes of the same name. See [Custom themes](#custom-themes) + [`TEMPLATES.md`](./TEMPLATES.md). |
| `MCP_JSA_DEFAULT_TEMPLATE` | `default` | Theme used when `render_pdf` has no explicit `template` argument. |
| `MCP_JSA_PUBLIC_BASE_URL` | _empty_ | Public URL emitted in artifact links. Default: `http://127.0.0.1:<port>`. Set when running on a remote host (Tailscale, LAN, etc.) — see [Running on a remote host](#running-on-a-remote-host--tailscale). |
| `MCP_JSA_AUTH_TOKEN` | _empty_ | Bearer token gating `/mcp`, `/files/*`, and the dashboard. **Required** to bind to anything other than localhost — without it, a non-localhost bind refuses to start (default-deny). See [Security model](#security-model). |
| `MCP_JSA_SAMPLING` | `true` | Use MCP sampling for `api`/batch scoring **when the connected client advertises it** (most, incl. Claude Desktop, don't — then the BYO key is used). Set `false` to always use the BYO key. |
| `MCP_JSA_LLM_PROVIDER` | `gemini` | BYO-key path for `api`/batch scoring — used whenever the client doesn't support sampling (the common case): `gemini`, `deepseek`, `none` |
| `MCP_JSA_LLM_MODEL` | _empty_ | Provider-specific model id |
| `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` | _empty_ | Provider credentials — needed for `api`/batch scoring unless your client supports MCP sampling (most don't; `mode="chat"` never needs a key) |
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

## Running on a remote host / Tailscale

By default every artifact link the server returns starts with `http://127.0.0.1:<port>`.
That's fine when you run server + chat on the same machine. If you run the server on a
cloud instance, a homelab box, or anything you reach over Tailscale / LAN / a tunnel,
`127.0.0.1` on the link resolves to your *chat machine* — not the server — and the
links don't work.

Set `MCP_JSA_PUBLIC_BASE_URL` to the URL the chat machine actually uses to reach the
server:

```bash
# Tailscale magic DNS
export MCP_JSA_PUBLIC_BASE_URL="https://jobs.example.ts.net"

# Tailscale 100.x IP
export MCP_JSA_PUBLIC_BASE_URL="http://100.64.0.5:7891"

# LAN IP
export MCP_JSA_PUBLIC_BASE_URL="http://192.168.1.20:7891"

# Reverse proxy
export MCP_JSA_PUBLIC_BASE_URL="https://jobs.example.com"
```

Every artifact link (resume PDF, .tex, .docx, eval report, apply_prefill screenshot,
tracker URL) now uses that base. The server still binds to `MCP_JSA_HOST` (default
`127.0.0.1`); to accept connections from other devices, also set `MCP_JSA_HOST=0.0.0.0`
— **which now requires `MCP_JSA_AUTH_TOKEN`** (see [Security model](#security-model)).
`npx job_ops-mcp doctor` prints the effective public base URL and auth posture.

A malformed value (e.g. `not-a-url`) is rejected at boot with a warning on stderr; the
server keeps running with the default 127.0.0.1 base. Trailing slashes are stripped.

---

## Security model

This server handles **PII**: your resume PDFs, cover letters, eval reports, your
LinkedIn connections, and H1B-derived employer data. The auth posture is decided entirely
by **where you bind** and **whether a token is set**:

| Bind (`MCP_JSA_HOST`) | `MCP_JSA_AUTH_TOKEN` | Result |
|---|---|---|
| `127.0.0.1` (default) | unset | **Open** — frictionless local use. PII stays on loopback. |
| `127.0.0.1` | set | **Token required** — bearer auth enforced even locally (opt-in). |
| `0.0.0.0` / LAN / Tailscale | **unset** | **Refuses to start** (default-deny). |
| `0.0.0.0` / LAN / Tailscale | set | **Token required** — bearer auth on every PII route. |

When a token is required, every PII-bearing route — the MCP endpoint (`/mcp`), the file
server (`/files/*`), and the tracker dashboard (`/`) — demands an
`Authorization: Bearer <token>` header. Requests without it get `401` with a
`WWW-Authenticate` header pointing at the protected-resource metadata document
(`/.well-known/oauth-protected-resource`). This aligns with the MCP 2025-06-18 model of
treating the server as an **OAuth Resource Server**, to the extent practical for a
self-hosted single-user tool: one operator-provisioned static token, no full
authorization-server flow.

```bash
# Expose over Tailscale/LAN — generate a strong token first.
export MCP_JSA_HOST=0.0.0.0
export MCP_JSA_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_JSA_PUBLIC_BASE_URL="https://jobs.example.ts.net"
npx job_ops-mcp start
```

**What's protected:** `/mcp`, `/files/*`, `/`. **What's open by design:** `/healthz`
(liveness, no PII) and the discovery metadata. **Hard rule:** PII must never be served
unauthenticated to a network — the default-deny boot guard exists precisely so a missing
token fails loudly instead of silently exposing your data. Still prefer a private network
(Tailscale / VPN / authenticated reverse proxy) over the public internet.

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

### Custom themes

`render_pdf` accepts a `template` argument — pick a named theme to render with.
Themes are directories under `templates/themes/<name>/` holding any of:

```
resume.tex    cover.tex    resume.html    cover.html
```

Out of the box you get `default`. To author your own:

```bash
mkdir -p ~/job-themes/compact
# Author resume.tex / cover.tex / resume.html / cover.html in there.
# Each theme file is a plain template with {{PLACEHOLDER}} slots — see
# TEMPLATES.md for the full placeholder contract.

export MCP_JSA_TEMPLATE_DIR=~/job-themes
npx job_ops-mcp templates             # lists bundled + user themes

# Then in your MCP chat:
# render_pdf job_id=... kind=both formats=["pdf","tex"] template="compact" cover_body="..."
```

The loader checks `$MCP_JSA_TEMPLATE_DIR` **first**, so a `default/` directory
inside your themes dir overrides the bundled default. Set `MCP_JSA_DEFAULT_TEMPLATE`
to make a non-`default` theme the implicit default for every call.

| Env var | Default | What it does |
|---------|---------|--------------|
| `MCP_JSA_TEMPLATE_DIR` | _empty_ | Extra dir holding your custom themes (one subdir per theme). |
| `MCP_JSA_DEFAULT_TEMPLATE` | `default` | Theme used when `render_pdf` has no explicit `template` arg. |

A custom theme that omits a placeholder degrades gracefully (the section is dropped,
the renderer does not crash). A malformed theme (missing `\documentclass`, missing
`\begin{document}`, etc.) returns a clear error naming the theme + file — pdflatex's
own backtrace never reaches the user. The visa-leakage scan and ATS hard rules apply
regardless of which theme you pick.

See [`TEMPLATES.md`](./TEMPLATES.md) for the full placeholder reference + an example
custom theme.

> `.docx` is generated programmatically and does **not** use themes. The Word file
> follows a fixed Calibri / heading-style layout for ATS friendliness; edit the
> output in Word if you need visual variation.

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

**Adding contacts from chat (no CSV).** Found someone useful mid-search, or want to capture a
few people without a bulk export? Use **`add_contacts`** — it takes an array of 1..N contacts
in one call and upserts them into the same store, so they show up in `find_warm_intros` /
`find_founders` immediately:

```text
add_contacts contacts=[
  { "full_name": "Dana Lee", "company": "Anthropic, Inc.", "title": "Staff Engineer",
    "linkedin_url": "https://linkedin.com/in/dana-lee" },
  { "full_name": "Sam Park", "company": "Vercel", "title": "Head of Talent" }
]
```

Only `full_name` is required. It matches existing people (by `linkedin_url`, else
`full_name` + company) so there are **no silent duplicates**; merges on update (omitted
fields are preserved); resolves company names with the **same fuzzy normalization** as the CSV
path; and infers `is_recruiter` / `is_engineering` / `is_leadership` from the title unless you
pass them. Partial contacts are stored and the per-contact result reports what was missing
(`no linkedin_url`, company unmatched, …) so the chat can ask you to fill the gaps. (Claude
parses your free-text/pasted contact info into these fields before calling.)

Company names are matched **fuzzily** so legal-name variants line up: `import_linkedin`,
`import_h1b`, JD ingestion, `visa_signal`, and `find_warm_intros` all normalize names by
stripping common legal suffixes (Inc, LLC, PBC, Ltd, Corp, Co, GmbH, …), lowercasing, and
trimming punctuation. So a LinkedIn connection at "Anthropic", an H1B filing under
"ANTHROPIC PBC", and a JD scraped as "Anthropic, Inc." all resolve to the **same company
row** — which is what makes warm-intro and visa-signal joins actually work. Resolved
variants are recorded in the `company_aliases` table.

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
