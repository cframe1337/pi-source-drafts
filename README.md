# pi-source-drafts

[![test](https://github.com/cframe1337/pi-source-drafts/actions/workflows/test.yml/badge.svg)](https://github.com/cframe1337/pi-source-drafts/actions/workflows/test.yml)

**Persistent draft storage for information discovered during pi coding sessions.**

Web searches, fetched pages, GitHub analysis, and user-provided external context are ephemeral — they vanish on session end or compaction. This extension preserves them as structured Markdown draft files in `~/.pi/source-drafts/`.

## Quick Start

```bash
# Via npm (recommended)
npm install pi-source-drafts

# Or via pi
pi install pi-source-drafts

# Or clone directly for development
git clone https://github.com/cframe1337/pi-source-drafts ~/.pi/agent/extensions/pi-source-drafts
```

Reload extensions (`/reload` in pi) or use in a single session:

```bash
pi -e ~/.pi/agent/extensions/pi-source-drafts/src/index.ts
```

## What It Does

| Trigger | Action |
|---------|--------|
| `web_search` tool result | Auto-captures query + results as a draft |
| `fetch_content` tool result | Auto-captures URL + content as a draft |
| `ctx_execute` / `ctx_execute_file` / `ctx_batch_execute` | Auto-captures execution output |
| `ctx_index` tool result | Auto-captures indexed content |
| LLM calls `save_draft(...)` | Saves structured info (by source type) |
| LLM calls `search_drafts(...)` | Searches saved drafts with relevance ranking |
| LLM calls `draft_bundle(...)` | Combines multiple drafts into a research brief |
| User runs `/save-source` | Creates a manual draft |
| User runs `/drafts` | Lists, views, searches, exports, or deletes drafts |

## Commands

```
/drafts                        List all drafts
/drafts view <id>              Show draft content
/drafts search <query>         Find drafts by title/content
/drafts delete <id>            Remove a draft
/drafts export <id>            Export as standalone markdown
/drafts bundle <name> <ids>    Combine drafts into a research brief
/drafts compact                Rebuild search index (remove orphans)
/drafts stats                  Show statistics by source type
/save-source <title> | <text>  Save external info manually
```

## LLM Tools

| Tool | Description |
|------|-------------|
| `save_draft(title, content, sourceType, sourceUrl?, tags?)` | Save structured information as a persistent draft |
| `search_drafts(query, sourceType?, tags?, limit?)` | Search saved drafts by keywords, type, or tags — current project and session results rank higher |
| `draft_bundle(title, draftIds)` | Combine multiple related drafts into one research brief |

## Storage Layout

```
~/.pi/source-drafts/
├── index.json              # Draft registry (id, title, type, date, tags, project, session, model)
├── search.idx              # Inverted index for fast full-text search
└── src-web_search-.../
    ├── draft.md            # Structured Markdown content
    └── meta.json           # Machine metadata (project, session, model, tags, url)
```

Each draft stores the project directory and pi session it was captured in. Search results from the current project and session get boosted relevance.

## Source Types

| Type | Description |
|------|-------------|
| `web_search` | Search engine query + results |
| `fetch_content` | Fetched URL content |
| `user_source` | User-provided external reference |
| `user_news` | User-provided update/note |
| `code_snippet` | Code example or pattern from analysis |

## Features

- **Auto-capture** — web searches, fetched pages, and context-mode tool results are saved automatically
- **Content de-duplication** — FNV-1a hash prevents duplicate saves
- **Section-level indexing** — `##` headings are indexed separately for precise search results
- **Project/session context** — each draft records the project directory and pi session, search prioritises current context
- **Model tracking** — each draft records the LLM provider/model used during capture
- **Secret redaction** — API keys, tokens, and private keys are automatically stripped before writing
- **Draft bundling** — combine related drafts into a single research brief
- **Export** — single drafts can be exported as standalone markdown with YAML frontmatter

## Search Architecture

Drafts are indexed with an inverted word index (persisted as `search.idx`). Queries are tokenised with stop-word removal, matched against titles (weighted 3×) and content (weighted 1×), and ranked by cumulative score. Results from the current project (+5 boost) and session (+10 boost) rank higher.

A 500-file search completes in O(k·|q|) where k ≈ matched draft count per term.

## Security

Credentials are automatically redacted before writing:

- API keys (`sk-...`, `AKIA...`)
- Private keys (RSA, EC, OpenSSH)
- GitHub tokens (`github_pat_...`)
- Bearer tokens
- Generic `api_key`, `secret`, `password`, `token` patterns

Drafts never leave your machine — they are stored locally only.

## Development

```bash
# Compile check:
cd ~/.pi/agent/extensions/pi-source-drafts
npx tsc --noEmit

# Project structure:
#   src/index.ts        — Extension entry: hooks, tools, commands
#   src/draft-store.ts  — File I/O, secret scanner, search
#   skills/             — Skill definitions
#   package.json        — Extension metadata
```

## License

MIT
