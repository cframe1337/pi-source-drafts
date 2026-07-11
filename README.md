# pi-source-drafts

[![test](https://github.com/cframe1337/pi-source-drafts/actions/workflows/test.yml/badge.svg)](https://github.com/cframe1337/pi-source-drafts/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/pi-source-drafts)](https://www.npmjs.com/package/pi-source-drafts)
[![npm downloads/month](https://img.shields.io/npm/dm/pi-source-drafts)](https://www.npmjs.com/package/pi-source-drafts)
[![GitHub stars](https://img.shields.io/github/stars/cframe1337/pi-source-drafts)](https://github.com/cframe1337/pi-source-drafts)
[![License](https://img.shields.io/github/license/cframe1337/pi-source-drafts)](https://github.com/cframe1337/pi-source-drafts)

**Persistent draft storage for information discovered during pi coding sessions.**

Web searches, fetched pages, GitHub analysis, and user-provided external context are ephemeral — they vanish on session end or compaction. This extension preserves them as structured Markdown draft files in `~/.pi/source-drafts/`.

## Quick Start

```bash
npm install pi-source-drafts
# or
pi install npm:pi-source-drafts

# dev clone
git clone https://github.com/cframe1337/pi-source-drafts ~/.pi/agent/extensions/pi-source-drafts
```

Reload extensions (`/reload` in pi) or run a single session:

```bash
pi -e ~/.pi/agent/extensions/pi-source-drafts/src/index.ts
```

## What It Does

| Trigger | Action |
|---------|--------|
| Tool call (captured via `tool_result` hook) | Action |
|------------|--------|
| `web_search` | Auto-captures query + results as a draft |
| `fetch_content` | Auto-captures URL + content as a draft |
| `ctx_execute` / `ctx_execute_file` / `ctx_batch_execute` | Auto-captures execution output |
| `ctx_index` | Auto-captures indexed content |
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
/drafts compact                Write index snapshot
/drafts compact-content        Compact the binary content store
/drafts cc                     Alias for compact-content
/drafts stats                  Show statistics by source type
/save-source <title> | <text>  Save external info manually
```

## LLM Tools

| Tool | Description |
|------|-------------|
| `save_draft(title, content, sourceType, sourceUrl?, tags?)` | Save structured information as a persistent draft |
| `search_drafts(query, sourceType?, tags?, limit?)` | Search saved drafts by keywords, type, or tags — current project and session results rank higher |
| `draft_bundle(title, draftIds)` | Combine multiple related drafts into one research brief |

## Storage Layout (v0.2+)

```
~/.pi/source-drafts/
├── journal.jsonl           # Append-only WAL (single source of truth)
├── index.snapshot          # Binary checkpoint (fast startup)
├── index.format            # Format version marker
├── drafts.cdb              # Binary content store (optional, hot cache)
└── src-web_search-.../
    ├── draft.md            # Structured Markdown content (backward compat)
    └── meta.json           # Machine metadata
```

**v0.1 auto-migrates on first run** — old `index.json` + `search.idx` are converted to `journal.jsonl` and deleted.

## Search Architecture (v0.2)

Inverted word index **held in RAM** — zero disk I/O for search queries.
TF-IDF ranking with per-term document frequency + log-scaled term frequency.
Titles weighted 2×, body 1×. Current project (+5) and session (+10) boost.

**v0.1 vs v0.2 performance (benchmarked):**

| Operation | v0.1 (200 docs) | v0.2 (200 docs) |
|-----------|-----------------|-----------------|
| Save | ~60 ms (rewrites whole search.idx) | **1.3 ms** (append journal only) |
| Search "deep dive" | ~5 ms | **3-5 ms** (no disk read) |
| Search "JavaScript" | ~3 ms | **3 ms** |
| Delete all 200 | ~5-15 s (rm -rf per folder) | **240 ms** (journal append + memory) |
| Startup cold | ~100 ms (parse JSON idx) | **34 ms** (snapshot + short replay) |

No more JSON index rewrite. No more slow deletes. No more startup lag.

Delete is instant: one `{"op":"delete"}` line appended to the journal + removed from memory index. File cleanup is background.

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
- **Secret redaction** — API keys, tokens, private keys, SSN, credit cards, phone numbers are automatically stripped before writing
- **Draft bundling** — combine related drafts into a single research brief
- **Export** — single drafts can be exported as standalone markdown with YAML frontmatter
- **Binary content store** — optional fast content cache (`drafts.cdb`), append-only with tombstone delete and in-place compaction
- **Write queue** — FIFO serialization for concurrent writes, reads are lock-free

## Security

Credentials are automatically redacted before writing:

- API keys (`sk-...`, `pk-...`, `rk-...`)
- AWS keys (`AKIA...`, `ASIA...`)
- Private keys (RSA, EC, OpenSSH, DSA)
- GitHub tokens (`github_pat_...`, `ghp_...`)
- Bearer tokens
- SSN (`\d{3}-\d{2}-\d{4}`)
- Credit cards (major formats)
- Phone numbers (CIS + US)
- Generic `api_key`, `secret`, `password`, `token` patterns

Drafts never leave your machine — they are stored locally only.

## Development

```bash
bun test              # 71 tests, ~3s
bun test --timeout 120 # includes benchmarks
```

Project structure:

```
src/
├── index.ts              # Extension entry: hooks, tools, commands
├── draft-store.ts        # Façade: Journal + MemoryIndex + ContentStore + WriteQueue
├── rw-queue.ts           # FIFO write queue
├── journal.ts            # Append-only WAL + snapshot
├── memory-index.ts       # In-memory inverted index + TF-IDF
├── content-store.ts      # Binary content store (CDB)
├── scanner.ts            # Security scanner v2
├── migration.ts          # v0.1 → v0.2 converter
├── *.test.ts             # Tests + benchmarks
skills/                   # Skill definitions
ARCHITECTURE.md           # Full design document
```

## License

MIT
