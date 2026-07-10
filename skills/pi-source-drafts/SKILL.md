---
name: pi-source-drafts
description: |
  pi-source-drafts auto-captures external source information into
  structured, persistent Markdown draft files. Handles web search
  results, fetched page content, GitHub analysis, user-provided
  external info, and code snippets.
source: extension
invocation: automatic
trigger:
  - tool_result of web_search / fetch_content / ctx_execute → auto-capture
  - save_draft tool (LLM saves info)
  - search_drafts tool (LLM searches saved drafts by keywords/tags/type)
  - draft_bundle tool (LLM combines drafts into a research brief)
  - before_agent_start injects draft stats so the model knows it exists
  - /drafts command (list, view, search, delete, export, bundle, stats)
  - /save-source command (manual save by user)
---

# pi-source-drafts

Information discovered during a session (web searches, fetched URLs,
GitHub code reviews, user-provided external context) is ephemeral —
it lives in the LLM's context window and disappears on compaction or
session end. pi-source-drafts preserves that information as structured
draft files in `~/.pi/source-drafts/`.

## LLM-visible tools

| Tool | Description |
|------|-------------|
| `save_draft(title, content, sourceType, sourceUrl?, tags?)` | Save a structured draft |
| `search_drafts(query, sourceType?, tags?, limit?)` | Search saved drafts by keywords, type, or tags with relevance ranking (current project + session rank higher) |
| `draft_bundle(title, draftIds)` | Combine multiple drafts into a single research brief |

## before_agent_start context injection

On each turn, if drafts exist, the model receives a compact notice:

> [DRAFT STORE: 12 saved drafts across all projects (web_search: 5, ...)]
> Global drafts: ~/.pi/source-drafts. Current project: my-project.
> Use search_drafts to search — current project + session results rank first.
> Use save_draft to save new information.

This ensures the model knows drafts exist without extra prompting.

## Search architecture

Drafts are indexed with an inverted word index (persisted as
`<outDir>/search.idx`). Queries are tokenised with stop-word removal,
matched against titles (weighted 3×) and content (weighted 1×),
and ranked by cumulative score. Results from the current project
(+5 boost) and current session (+10 boost) rank higher.

Supports:
- Free-text keyword search (tokenised, stop-word filtered)
- sourceType filter (`web_search`, `fetch_content`, etc.)
- Tags filter (array intersection)
- Limit (default 50)

## Output format

```
~/.pi/source-drafts/
├── index.json              # registry
├── search.idx              # inverted index (FTS)
└── src-web_search-.../
    ├── draft.md
    └── meta.json           # includes projectDir, sessionId, model
```
