/**
 * pi-source-drafts — main extension entry
 *
 * Auto-captures external source info from web_search / fetch_content,
 * provides save_draft + search_drafts tools for the LLM,
 * and /drafts + /save-source commands.
 *
 * before_agent_start injects a context block so the model knows
 * drafts exist and can search them.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { draftStore } from "./draft-store.ts";
import type { DraftIndexEntry, SourceType } from "./draft-store.ts";

const CAPTURED_TOOLS = new Set(["web_search", "fetch_content", "ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_index"]);

function nowISO(): string {
	return new Date().toISOString();
}

let _currentSessionName: string | undefined;
let _currentModel: string | undefined;

function sessionIdFromCtx(ctx: ExtensionContext): string | undefined {
	const file = ctx.sessionManager.getSessionFile();
	return file?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "");
}

function modelFromCtx(ctx: ExtensionContext): string | undefined {
	// ctx.model exists at runtime but isn't in the TS types
	const m = (ctx as unknown as Record<string, unknown>).model;
	if (m && typeof m === "object") {
		const obj = m as Record<string, unknown>;
		const p = obj.provider as string | undefined;
		const id = obj.id as string | undefined;
		if (p && id) return `${p}/${id}`;
		if (id) return String(id);
	}
	return _currentModel;
}

function parseCommandArgs(input: string): { positional: string[]; flags: Record<string, string | boolean> } {
	const tokens = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--")) {
			const key = t.slice(2);
			const next = tokens[i + 1];
			if (next && !next.startsWith("--")) { flags[key] = next; i++; }
			else flags[key] = true;
		} else {
			positional.push(t);
		}
	}
	return { positional, flags };
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: Record<string, unknown>) => {
				if (c.type === "text") return String(c.text ?? "");
				if (c.type === "image") {
					// Image inside content — extract url or note it
					const src = c.source as Record<string, unknown> | undefined;
					if (src?.type === "url") return `![](${src.url})`;
					if (src?.type === "base64") return `[base64 image: ${String(src.mediaType ?? "unknown")}]`;
					return `[image]`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return String(content ?? "");
}

/** FNV-1a hash for dedup */
function hashContent(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(8, "0");
}

function formatSearchResults(query: string, content: string): string {
	const lines = content.split("\n").filter(l => l.trim());
	const summary = lines.slice(0, 30).join("\n");
	return [
		`## Search Query\n\n${query}\n`,
		lines.length > 30 ? `*Results truncated: ${lines.length} lines total, showing first 30*` : "",
		"",
		summary,
		"",
		`> Saved by pi-source-drafts at ${nowISO()}`,
	].filter(Boolean).join("\n");
}

function formatFetchedContent(url: string, content: string): string {
	const lines = content.split("\n").filter(l => l.trim());
	const body = lines.slice(0, 200).join("\n");
	return [
		`## Source\n\n**URL:** ${url}\n`,
		lines.length > 200 ? `*Content truncated: ${lines.length} lines total, showing first 200*` : "",
		"",
		body,
		"",
		`> Saved by pi-source-drafts at ${nowISO()}`,
	].filter(Boolean).join("\n");
}

/** Format a draft entry for text display */
function formatDraftPreview(entry: DraftIndexEntry): string {
	const date = entry.createdAt.slice(0, 19).replace("T", " ");
	const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : "";
	const project = entry.projectDir ? ` (${entry.projectDir.split(/[/\\]/).pop()})` : "";
	return `  ${entry.id.slice(0, 28).padEnd(30)} ${date}  ${entry.sourceType.padEnd(14)} ${entry.title.slice(0, 50)}${project}${tags}`;
}

async function handleWebSearchResult(
	event: { toolName: string; input: Record<string, unknown>; content: unknown },
	ctx: ExtensionContext,
): Promise<void> {
	const query = String(event.input.query ?? event.input.queries ?? "(unknown)");
	const content = extractTextFromContent(event.content);
	if (!content.trim()) return;

	await draftStore.save({
		title: `Web Search: ${query.slice(0, 80)}`,
		content: formatSearchResults(query, content),
		sourceType: "web_search",
		tags: [],
		sourceHash: hashContent(content),
		projectDir: ctx.cwd,
		sessionId: sessionIdFromCtx(ctx),
		sessionName: _currentSessionName,
		model: modelFromCtx(ctx),
	});
}

async function handleFetchContentResult(
	event: { toolName: string; input: Record<string, unknown>; content: unknown },
	ctx: ExtensionContext,
): Promise<void> {
	const url = String(event.input.url ?? "(unknown URL)");
	const content = extractTextFromContent(event.content);
	if (!content.trim()) return;

	await draftStore.save({
		title: `Fetch: ${String(url).slice(0, 80)}`,
		content: formatFetchedContent(url, content),
		sourceType: "fetch_content",
		sourceUrl: String(url),
		sourceHash: hashContent(content),
		projectDir: ctx.cwd,
		sessionId: sessionIdFromCtx(ctx),
		sessionName: _currentSessionName,
		model: modelFromCtx(ctx),
	});
}

async function handleCtxExecuteResult(
	event: { toolName: string; input: Record<string, unknown>; content: unknown },
	ctx: ExtensionContext,
): Promise<void> {
	const intent = String(event.input.intent ?? "");
	const lang = String(event.input.language ?? "");
	const code = event.input.code ? String(event.input.code).slice(0, 120) : "";
	const path = event.input.path ? String(event.input.path) : "";
	const inputHint = intent || code || path || "(inline execution)";
	const content = extractTextFromContent(event.content);
	if (!content.trim() || content.length < 20) return;

	await draftStore.save({
		title: `[ctx-exec] ${inputHint.slice(0, 80)}`,
		content: [
			`## Context Analysis: ${intent || "data processing"}`,
			`**Tool:** ${event.toolName}${lang ? ` · **Language:** ${lang}` : ""}`,
			code ? `**Code:** \`${code}\`` : path ? `**Path:** \`${path}\`` : "",
			"",
			"---",
			"",
			content.slice(0, 30000),
			content.length > 30000 ? `\n*Output truncated: ${content.length} chars total*` : "",
			"",
			`> Saved by pi-source-drafts at ${nowISO()}`,
		].filter(Boolean).join("\n"),
		sourceType: "user_source",
		tags: ["ctx-exec", event.toolName, lang].filter(Boolean),
		sourceHash: hashContent(content),
		projectDir: ctx.cwd,
		sessionId: sessionIdFromCtx(ctx),
		sessionName: _currentSessionName,
		model: modelFromCtx(ctx),
	});
}

// Extension entry
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, _ctx) => {
		await draftStore.init();
		_currentSessionName = pi.getSessionName?.();
		_currentModel = undefined; // updated on model_select
	});

	pi.on("model_select", async (event) => {
		_currentModel = event.model ? `${event.model.provider}/${event.model.id}` : undefined;
	});

	pi.on("session_info_changed", async () => {
		_currentSessionName = pi.getSessionName?.();
	});

	// auto capute tool_result
	pi.on("tool_result", async (event, ctx) => {
		if (!CAPTURED_TOOLS.has(event.toolName)) return;
		try {
			if (event.toolName === "web_search") await handleWebSearchResult(event, ctx);
			else if (event.toolName === "fetch_content") await handleFetchContentResult(event, ctx);
			else await handleCtxExecuteResult(event, ctx);
		} catch (err) {
			ctx.ui.notify?.(`[source-drafts] capture error: ${(err as Error).message}`, "error");
		}
	});

	// inject draft context before_agent_start so the model knows it can search
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const stats = await draftStore.getStats();
			if (stats.total === 0) return;

			const byType = Object.entries(stats.byType)
				.map(([t, n]) => `${t}: ${n}`)
				.join(", ");

			const currentProject = ctx?.sessionManager?.getSessionFile?.()
				? ctx.cwd.split(/[/\\]/).pop()
				: "(unknown)";

			const content = [
				`[DRAFT STORE: ${stats.total} saved drafts across all projects (${byType})]`,
				`Global drafts: \`${draftStore.outDir}\`. Current project: ${currentProject}.`,
				`Use \`search_drafts\` to search — current project + session results rank first.`,
				`Use \`save_draft\` to save new information.`,
			].join("\n");

			return {
				message: {
					customType: "source-drafts-context",
					content,
					display: false,
				},
			};
		} catch {
			return;
		}
	});

	// Tool: save_draft (LLM saves discovered info)
	pi.registerTool({
		name: "save_draft",
		label: "Save Draft",
		description:
			"Save structured information from external sources as a persistent Markdown draft file. " +
			"Use whenever you discover important information from web searches, fetched pages, " +
			"GitHub repositories, or user-provided content that should be preserved beyond this session. " +
			"Drafts are stored in the project's draft store and searchable via search_drafts.",

		promptSnippet: "Save important information as a structured draft for later reference",
		promptGuidelines: [
			"Use save_draft when you discover important external information — web results, fetched docs, code analysis — that the user should keep",
			"Set sourceType appropriately: web_search for search results, fetch_content for specific pages, code_snippet for code/repos, user_source for user-provided info",
			"Always extract and summarize the most valuable insights before saving",
			"Add relevant tags so the draft is findable later via search_drafts",
			"sourceUrl is highly recommended — include the original URL for attribution",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Descriptive title for the draft (max 120 chars)" }),
			content: Type.String({ description: "Full Markdown content. Include key findings, code snippets, tables, or summaries" }),
			sourceType: StringEnum(["web_search", "fetch_content", "user_source", "user_news", "code_snippet"] as const),
			sourceUrl: Type.Optional(Type.String({ description: "Original source URL if applicable" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization (e.g., jni, rust, performance)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { folderPath, deduped } = await draftStore.save({
				title: params.title,
				content: params.content,
				sourceType: params.sourceType,
				sourceUrl: params.sourceUrl,
				tags: params.tags,
				projectDir: ctx?.cwd,
				sessionId: ctx?.sessionManager?.getSessionFile?.()?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, ""),
				sessionName: _currentSessionName,
				model: ctx ? modelFromCtx(ctx) : _currentModel,
			});
			const note = deduped ? " (duplicate, skipped)" : "";
			return {
				content: [{ type: "text", text: `✓ Draft saved: "${params.title}"${note}\n  Location: ${folderPath}` }],
				details: { folderPath, title: params.title, sourceType: params.sourceType, deduped },
			};
		},
	});

	// Tool: search_drafts (LLM searches saved drafts)
	pi.registerTool({
		name: "search_drafts",
		label: "Search Drafts",
		description:
			"Search previously saved drafts by keywords, source type, or tags. " +
			"Returns matching draft entries ranked by relevance. " +
			"Use before asking the user to re-explain something you already found.",
		promptSnippet: "Search previously saved drafts by keywords, source type, or tags",
		promptGuidelines: [
			"Use search_drafts to find previously saved information before asking the user to re-provide it",
			"Supports sourceType filter: narrow to web_search, fetch_content, code_snippet, etc.",
			"Supports tags filter for fine-grained categorization",
			"Results are ranked by relevance; read full draft with /drafts view <id> if preview is insufficient",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search keywords (e.g., 'jni performance opengl benchmark')" }),
			sourceType: Type.Optional(StringEnum(["web_search", "fetch_content", "user_source", "user_news", "code_snippet"] as const)),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (e.g., ['jni', 'rust'])" })),
			limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentProject = ctx?.cwd;
			const currentSession = ctx?.sessionManager?.getSessionFile?.()?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "");
			const results = await draftStore.search({
				query: params.query,
				sourceType: params.sourceType,
				tags: params.tags,
				limit: params.limit ?? 10,
				currentProject,
				currentSession,
			});

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No drafts found matching "${params.query}".` }],
					details: { query: params.query, count: 0 },
				};
			}

			const lines = results.map((d, i) => {
				const e = d.entry;
				const excerpt = d.content
					.replace(/^#[^\n]*\n(?:>[^\n]*\n)*\n?---\n*/s, "") // strip header
					.replace(/^>.*$/m, "") // strip footer quote
					.slice(0, 200)
					.replace(/\n+/g, " ")
					.trim();
				const projectLabel = e.projectDir ? ` | ${e.projectDir.split(/[/\\]/).pop()}` : "";
				const modelLabel = e.model ? ` | ${e.model}` : "";
				return [
					`${i + 1}. **${e.title}**`,
					`   ID: \`${e.id.slice(0, 40)}…\` | ${e.sourceType}${projectLabel}${modelLabel} | ${e.createdAt.slice(0, 19).replace("T", " ")}`,
					e.sourceUrl ? `   URL: ${e.sourceUrl}` : "",
					e.tags.length ? `   Tags: ${e.tags.join(", ")}` : "",
					`   > ${excerpt}${d.content.length > 200 ? "…" : ""}`,
				].filter(Boolean).join("\n");
			});

			return {
				content: [{
					type: "text",
					text: `Found ${results.length} draft(s) for "${params.query}":\n\n${lines.join("\n")}`,
				}],
				details: { query: params.query, count: results.length, sourceType: params.sourceType, tags: params.tags },
			};
		},
	});

	// Tool: draft_bundle (LLM bundles drafts into a research brief)
	pi.registerTool({
		name: "draft_bundle",
		label: "Bundle Drafts",
		description:
			"Combine multiple saved drafts into a single research brief markdown file. " +
			"Use when you need to merge related findings (e.g. several web searches about the same topic) " +
			"into one coherent document.",
		promptSnippet: "Combine related drafts into a research brief",
		promptGuidelines: [
			"Use draft_bundle when multiple drafts cover the same topic and should be merged",
			"Provide a clear brief title that summarizes the combined content",
			"Find draft IDs via search_drafts first",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Title for the bundled research brief" }),
			draftIds: Type.Array(Type.String(), { description: "Array of draft IDs to bundle (find via search_drafts)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { path, count } = await draftStore.bundle(params.draftIds, params.title);
			return {
				content: [{ type: "text", text: `Bundled ${count} draft(s) into research brief: ${path}` }],
				details: { path, title: params.title, count },
			};
		},
	});

	// Command: /drafts
	pi.registerCommand("drafts", {
		description: "Manage saved source drafts: list, view <id>, search <query>, delete <id>",
		handler: async (args, ctx) => {
			const { positional } = parseCommandArgs(args);
			const sub = positional[0] ?? "list";

			if (sub === "list" || sub === "ls") {
				const drafts = await draftStore.list();
				if (drafts.length === 0) {
					ctx.ui.notify("No drafts saved yet.", "info");
					return;
				}
				const lines = drafts.map(formatDraftPreview);
				ctx.ui.notify(`Drafts (${drafts.length} total):\n` + lines.join("\n"), "info");
				return;
			}

			if ((sub === "view" || sub === "show") && positional[1]) {
				const draft = await draftStore.get(positional[1]);
				if (!draft) { ctx.ui.notify(`Draft not found: ${positional[1]}`, "error"); return; }
				const preview = draft.content.length > 2000
					? draft.content.slice(0, 2000) + "\n\n... (truncated, see " + draft.entry.folderName + "/draft.md)"
					: draft.content;
				ctx.ui.notify(preview, "info");
				return;
			}

			if (sub === "search" && positional[1]) {
				const query = positional.slice(1).join(" ");
				const results = await draftStore.search(query);
				if (results.length === 0) { ctx.ui.notify(`No drafts matching "${query}".`, "info"); return; }
				const lines = results.map(r => formatDraftPreview(r.entry));
				ctx.ui.notify(`Found ${results.length} draft(s) for "${query}":\n` + lines.join("\n"), "info");
				return;
			}

			if ((sub === "delete" || sub === "rm") && positional[1]) {
				const ok = await draftStore.delete(positional[1]);
				ctx.ui.notify(ok ? `Deleted: ${positional[1]}` : `Not found: ${positional[1]}`, ok ? "info" : "error");
				return;
			}

			if ((sub === "export" || sub === "ex") && positional[1]) {
				const result = await draftStore.exportDraft(positional[1]);
				if (!result) { ctx.ui.notify(`Draft not found: ${positional[1]}`, "error"); return; }
				ctx.ui.notify(`Exported to: ${result.path}`, "info");
				return;
			}

			if ((sub === "compact" || sub === "gc")) {
				const { removed } = await draftStore.compactIndex();
				ctx.ui.notify(`Index compacted. Removed ${removed} orphaned entries.`, "info");
				return;
			}

			if ((sub === "compact-content" || sub === "cc")) {
				const result = await draftStore.compactContent();
				ctx.ui.notify(result
					? `Content store compacted: ${result.before} → ${result.after} entries.`
					: "Content store not available.",
					"info");
				return;
			}

			if ((sub === "stats" || sub === "st")) {
				const s = await draftStore.getStats();
				const byType = Object.entries(s.byType).map(([t, n]) => `${t}: ${n}`).join(", ");
				ctx.ui.notify(`Drafts: ${s.total} total (${byType})
Oldest: ${s.oldest.slice(0, 10)}\nNewest: ${s.newest.slice(0, 10)}`, "info");
				return;
			}

			if ((sub === "bundle" || sub === "b") && positional[1]) {
				// bundle <name> <id1> <id2> ... — combine drafts into a brief
				const name = positional[1];
				const ids = positional.slice(2);
				if (ids.length === 0) { ctx.ui.notify("Usage: /drafts bundle <brief-name> <id1> <id2> ...", "info"); return; }
				const { path, count } = await draftStore.bundle(ids, name);
				ctx.ui.notify(`Bundled ${count} draft(s) → ${path}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /drafts                    — list all\n  /drafts view <id>           — view draft\n  /drafts search <q>          — search\n  /drafts delete <id>         — delete\n  /drafts export <id>         — export as standalone MD\n  /drafts bundle <name> <ids> — bundle into research brief\n  /drafts compact             — rebuild search index\n  /drafts stats               — show statistics",
				"info",
			);
		},
	});

	// Command: /save-source
	pi.registerCommand("save-source", {
		description: "Manually save external source. Usage: /save-source <title> | <url-or-text>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /save-source <title> | <url-or-text>", "info");
				return;
			}

			const sepIdx = args.indexOf(" | ");
			let title: string;
			let content: string;

			if (sepIdx >= 0) {
				title = args.slice(0, sepIdx).trim();
				content = args.slice(sepIdx + 3).trim();
			} else {
				title = "Manual Source Entry";
				content = args.trim();
			}

			if (!content) { ctx.ui.notify("No content. Usage: /save-source <title> | <text>", "error"); return; }

			const sourceType: SourceType = content.match(/^https?:\/\//) ? "user_source" : "user_news";

			const { folderPath, deduped } = await draftStore.save({
				title: title.slice(0, 120),
				content: `## ${title}\n\n${content}\n\n> Saved manually via /save-source at ${nowISO()}`,
				sourceType,
				sourceUrl: sourceType === "user_source" ? content : undefined,
				projectDir: ctx.cwd,
				sessionId: sessionIdFromCtx(ctx),
				sessionName: _currentSessionName,
				model: modelFromCtx(ctx),
			});
			const note = deduped ? " (duplicate)" : "";
			ctx.ui.notify(`Draft saved: "${title}" → ${folderPath}${note}`, "info");
		},
	});
}
