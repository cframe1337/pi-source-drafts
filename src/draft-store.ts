/**
 * pi-source-drafts — draft store: file I/O, secret scanner, FTS search
 *
 * Output dir: ~/.pi/source-drafts (global default) or configured via outDir arg.
 * Search index: persistent inverted index (<outDir>/search.idx) for fast
 *   keyword lookup across 500+ files without scanning every draft.md.
 * Each draft stores projectDir + sessionId so results can be ranked by relevance
 * to the current context.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// Types

export type SourceType = "web_search" | "fetch_content" | "user_source" | "user_news" | "code_snippet";
export interface DraftIndexEntry {
	id: string;
	title: string;
	sourceType: SourceType;
	sourceUrl?: string;
	tags: string[];
	createdAt: string;
	folderName: string;
	projectDir?: string;
	sessionId?: string;
	/** Human-readable session name (set via /name) */
	sessionName?: string;
	/** Provider/model ID used when captured */
	model?: string;
}

export interface SaveDraftParams {
	title: string;
	content: string;
	sourceType: SourceType;
	sourceUrl?: string;
	tags?: string[];
	/** SHA256 hash of original content for dedup */
	sourceHash?: string;
	/** Project directory this draft was captured in (for context ranking) */
	projectDir?: string;
	/** Pi session ID this draft was captured in (for context ranking) */
	sessionId?: string;
	/** Human-readable session name (set via /name) */
	sessionName?: string;
	/** Provider/model ID used when captured */
	model?: string;
}

export interface Draft {
	entry: DraftIndexEntry;
	content: string;
}

export interface SearchQuery {
	query: string;
	sourceType?: SourceType;
	tags?: string[];
	limit?: number;
	/** If true, return section-level matches instead of whole drafts */
	sectionLevel?: boolean;
	/** Boost results matching this project directory */
	currentProject?: string;
	/** Boost results matching this session ID */
	currentSession?: string;
}

export interface SearchSectionResult {
	draftId: string;
	sectionHeading: string;
	content: string;
	score: number;
}

/** Shape of the on-disk search index */
interface SearchIndexData {
	version: 2;
	/** word → set of draft ids (serialised as arrays) */
	words: Record<string, string[]>;
	/** draft id → doc metadata */
	docs: Record<string, {
		title: string;
		titleWords: string[];
		contentWords: string[];
		sourceType: SourceType;
		tags: string[];
		sourceHash?: string;
		sections: { heading: string; words: string[] }[];
		projectDir?: string;
		sessionId?: string;
		sessionName?: string;
		model?: string;
	}>;
}

// Tokenizer
const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "shall",
	"should", "may", "might", "can", "could", "this", "that", "these",
	"those", "i", "me", "my", "we", "our", "you", "your", "he", "she",
	"it", "its", "they", "them", "their", "and", "or", "but", "if",
	"because", "as", "until", "while", "of", "at", "by", "for", "with",
	"about", "against", "between", "into", "through", "during", "before",
	"after", "above", "below", "to", "from", "up", "down", "in", "out",
	"on", "off", "over", "under", "again", "further", "then", "once",
	"here", "there", "when", "where", "why", "how", "all", "each", "every",
	"both", "few", "more", "most", "other", "some", "such", "no", "nor",
	"not", "only", "own", "same", "so", "than", "too", "very",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-zа-яё0-9]/g, " ")
		.split(/\s+/)
		.filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

// Secrets scanner

const SECRET_PATTERNS: [RegExp, string][] = [
	[/sk-[a-zA-Z0-9]{20,}/g, "sk-[REDACTED]"],
	[/AKIA[0-9A-Z]{16}/g, "AKIA[REDACTED]"],
	[/-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----[^]*?-----END \1 PRIVATE KEY-----/g, "[PRIVATE KEY REDACTED]"],
	[/github_pat_[a-zA-Z0-9]{22,}/g, "github_pat_[REDACTED]"],
	[/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]"],
	[/(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-.]{8,}/gi, "$1=[REDACTED]"],
];

function scanSecrets(text: string): string {
	let cleaned = text;
	for (const [re, replacement] of SECRET_PATTERNS) {
		cleaned = cleaned.replace(re, replacement);
	}
	return cleaned;
}

// Helpers

function shortId(): string {
	return Math.random().toString(36).slice(2, 6);
}

function nowISO(): string {
	return new Date().toISOString();
}

function generateSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-zа-я0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 40);
}

function folderName(sourceType: string, title: string): string {
	const ts = nowISO().replace(/[-:.]/g, "");
	const slug = generateSlug(title);
	return `src-${sourceType}-${ts}-${slug.slice(0, 24)}-${shortId()}`;
}

/** Split markdown content into sections by ## headings */
function splitIntoSections(content: string, title: string): { heading: string; body: string }[] {
	const sections: { heading: string; body: string }[] = [];
	const lines = content.split("\n");
	let currentHeading = "(preamble)";
	let currentBody: string[] = [];

	for (const line of lines) {
		const m = line.match(/^##\s+(.+)/);
		if (m) {
			if (currentBody.length) sections.push({ heading: currentHeading, body: currentBody.join("\n") });
			currentHeading = m[1].trim();
			currentBody = [];
		} else {
			currentBody.push(line);
		}
	}
	if (currentBody.length) sections.push({ heading: currentHeading, body: currentBody.join("\n") });
	return sections;
}

// Inverted-index search index
const SEARCH_INDEX_FILE = "search.idx";

function emptyIndex(): SearchIndexData {
	return { version: 2, words: {}, docs: {} };
}

function readSearchIndex(outDir: string): SearchIndexData {
	const path = join(outDir, SEARCH_INDEX_FILE);
	if (!existsSync(path)) return emptyIndex();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (raw?.version === 1) {
			// Upgrade v1 → v2: add sections field
			for (const id of Object.keys(raw.docs ?? {})) {
				(raw.docs[id] as Record<string, unknown>).sections = [];
			}
			raw.version = 2;
			writeSearchIndex(outDir, raw as SearchIndexData);
			return raw as SearchIndexData;
		}
		if (raw?.version === 2) return raw as SearchIndexData;
		return emptyIndex();
	} catch {
		return emptyIndex();
	}
}

function writeSearchIndex(outDir: string, idx: SearchIndexData): void {
	const path = join(outDir, SEARCH_INDEX_FILE);
	writeFileSync(path, JSON.stringify(idx), "utf-8");
}

/** Add a single document to the in-memory index (caller must persist) */
function indexDoc(
	idx: SearchIndexData, id: string, title: string, content: string,
	sourceType: string, tags: string[], sourceHash?: string,
	projectDir?: string, sessionId?: string,
	sessionName?: string, model?: string,
): void {
	const titleWords = tokenize(title);
	const contentWords = tokenize(content);
	const sections = splitIntoSections(content, title).map(s => ({
		heading: s.heading,
		words: tokenize(s.body),
	}));

	idx.docs[id] = { title, titleWords, contentWords, sourceType: sourceType as SourceType, tags, sourceHash, sections, projectDir, sessionId, sessionName, model };

	const allWords = [...new Set([...titleWords, ...contentWords])];
	for (const w of titleWords) {
		(idx.words[w] ??= []).push(id);
	}
	for (const w of contentWords) {
		(idx.words[w] ??= []).push(id);
	}
}

/** Remove a document from the in-memory index */
function deindexDoc(idx: SearchIndexData, id: string): void {
	const doc = idx.docs[id];
	if (!doc) return;
	const allWords = [...new Set([...doc.titleWords, ...doc.contentWords])];
	for (const w of allWords) {
		const list = idx.words[w];
		if (list) {
			const remaining = list.filter(x => x !== id);
			if (remaining.length) idx.words[w] = remaining;
			else delete idx.words[w];
		}
	}
	delete idx.docs[id];
}

// Draft store
export class DraftStore {
	private _initialized = false;
	private _outDir = "";
	private _searchIdx: SearchIndexData = emptyIndex();
	private _index: DraftIndexEntry[] = [];

	get outDir(): string {
		return this._outDir;
	}

	/** Ensure output directory exists. Default: ~/.pi/source-drafts */
	async init(outDir?: string): Promise<void> {
		if (this._initialized) return;
		this._outDir = outDir || join(homedir(), ".pi", "source-drafts");
		mkdirSync(this._outDir, { recursive: true });

		// Load persistent indices
		this._searchIdx = readSearchIndex(this._outDir);
		this._index = this._readIndex();

		// If search index is empty but drafts exist, rebuild
		if (Object.keys(this._searchIdx.docs).length === 0 && this._index.length > 0) {
			this._rebuildSearchIndex();
		}

		this._initialized = true;
	}

	/** Save a draft, returns folder path. If dedup hash matches, returns existing path with null suffix. */
	async save(params: SaveDraftParams): Promise<{ folderPath: string; deduped: boolean }> {
		this._guard();

		// Dedup: if sourceHash provided, check if a draft with same hash exists
		if (params.sourceHash) {
			const existing = Object.entries(this._searchIdx.docs).find(
				([, d]) => d.sourceHash === params.sourceHash,
			);
			if (existing) {
				return { folderPath: join(this._outDir, existing[0]), deduped: true };
			}
		}

		const folder = folderName(params.sourceType, params.title);
		const folderPath = join(this._outDir, folder);
		mkdirSync(folderPath, { recursive: true });

		const id = folder;
		const entry: DraftIndexEntry = {
			id,
			title: params.title,
			sourceType: params.sourceType,
			sourceUrl: params.sourceUrl,
			tags: params.tags ?? [],
			createdAt: nowISO(),
			folderName: folder,
			projectDir: params.projectDir,
			sessionId: params.sessionId,
			sessionName: params.sessionName,
			model: params.model,
		};

		const header = [
			`# ${params.title}`,
			`> **Source:** ${params.sourceType}${params.sourceUrl ? ` · **URL:** ${params.sourceUrl}` : ""} · **Date:** ${entry.createdAt}`,
			params.tags?.length ? `> **Tags:** ${params.tags.join(", ")}` : "",
			"",
			"---",
			"",
		].filter(Boolean).join("\n");

		const body = scanSecrets(params.content);
		const draftContent = header + body;

		writeFileSync(join(folderPath, "draft.md"), draftContent, "utf-8");
		writeFileSync(join(folderPath, "meta.json"), JSON.stringify(entry, null, 2), "utf-8");

		// Update index
		this._index.unshift(entry);
		this._writeIndex(this._index);

		// Update search index
		indexDoc(this._searchIdx, id, params.title, body, params.sourceType, params.tags ?? [], params.sourceHash, params.projectDir, params.sessionId, params.sessionName, params.model);
		writeSearchIndex(this._outDir, this._searchIdx);

		return { folderPath, deduped: false };
	}

	/** List all drafts (newest first) */
	async list(options?: { sourceType?: SourceType; tags?: string[] }): Promise<DraftIndexEntry[]> {
		this._guard();
		let entries = this._index;
		if (options?.sourceType) entries = entries.filter(e => e.sourceType === options.sourceType);
		if (options?.tags?.length) entries = entries.filter(e => options.tags!.some(t => e.tags.includes(t)));
		return entries;
	}

	/** Get a single draft by id */
	async get(id: string): Promise<Draft | null> {
		this._guard();

		const folderPath = join(this._outDir, id);
		if (existsSync(folderPath) && statSync(folderPath).isDirectory()) {
			return this._readDraftFromFolder(id, folderPath);
		}

		// Prefix match
		const match = this._index.find(e => e.id.includes(id));
		if (match) {
			return this._readDraftFromFolder(match.folderName, join(this._outDir, match.folderName));
		}

		return null;
	}

	/** Search drafts using the inverted index. Handles 500+ files in O(q) per query term. */
	async search(query: string): Promise<Draft[]>;
	async search(query: SearchQuery): Promise<Draft[]>;
	async search(query: string | SearchQuery): Promise<Draft[]> {
		this._guard();

		const q: SearchQuery = typeof query === "string" ? { query } : query;
		const limit = q.limit ?? 50;

		// Tokenize query into "mandatory" (prefixed with +) and optional terms
		const rawTokens = tokenize(q.query);
		if (rawTokens.length === 0) return [];

		// Score-based ranking
		const scores = new Map<string, number>();

		for (const token of rawTokens) {
			const hitIds = this._searchIdx.words[token];
			if (!hitIds) continue;

			for (const id of hitIds) {
				const doc = this._searchIdx.docs[id];
				if (!doc) continue;

				let score = 0;
				if (doc.titleWords.includes(token)) score += 3;
				if (doc.contentWords.includes(token)) score += 1;

				// Boost by project/session context
				if (q.currentProject && doc.projectDir === q.currentProject) score += 5;
				if (q.currentSession && doc.sessionId === q.currentSession) score += 10;

				scores.set(id, (scores.get(id) ?? 0) + score);
			}
		}

		if (scores.size === 0) return [];

		const ranked = [...scores.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit);

		let filtered = ranked;
		if (q.sourceType) {
			filtered = filtered.filter(([id]) => this._searchIdx.docs[id]?.sourceType === q.sourceType);
		}
		if (q.tags?.length) {
			filtered = filtered.filter(([id]) => {
				const t = this._searchIdx.docs[id]?.tags ?? [];
				return q.tags!.some(tag => t.includes(tag));
			});
		}

		const results: Draft[] = [];
		for (const [id] of filtered) {
			const doc = this._searchIdx.docs[id];
			if (!doc) continue;

			let draft = await this.get(id);
			if (!draft) {
				const entry = this._index.find(e => e.id === id || e.folderName === id);
				if (entry) draft = await this.get(entry.id);
			}
			if (draft) results.push(draft);
		}

		return results;
	}

	/** Delete a draft by id */
	async delete(id: string): Promise<boolean> {
		this._guard();

		// Find folder
		const exactPath = join(this._outDir, id);
		let folderToRemove: string | null = null;

		if (existsSync(exactPath) && statSync(exactPath).isDirectory()) {
			folderToRemove = exactPath;
		} else {
			const entry = this._index.find(e => e.id.includes(id) || e.folderName.includes(id));
			if (entry) folderToRemove = join(this._outDir, entry.folderName);
		}

		if (!folderToRemove) return false;
		rmSync(folderToRemove, { recursive: true, force: true });

		// Update index + search index
		const removedId = this._index.find(e => folderToRemove?.includes(e.folderName))?.id
			?? this._index.find(e => e.folderName === basename(folderToRemove))?.id;
		if (removedId) deindexDoc(this._searchIdx, removedId);

		this._index = this._index.filter(e => !folderToRemove?.includes(e.folderName));
		this._writeIndex(this._index);
		writeSearchIndex(this._outDir, this._searchIdx);
		return true;
	}

	private _guard(): void {
		if (!this._initialized) throw new Error("DraftStore not initialized. Call .init() first.");
	}

	private _readIndex(): DraftIndexEntry[] {
		const indexPath = join(this._outDir, "index.json");
		if (!existsSync(indexPath)) return [];
		try {
			return JSON.parse(readFileSync(indexPath, "utf-8"));
		} catch {
			return [];
		}
	}

	private _writeIndex(index: DraftIndexEntry[]): void {
		const indexPath = join(this._outDir, "index.json");
		writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
	}

	private _readDraftFromFolder(folder: string, folderPath: string): Draft | null {
		const metaPath = join(folderPath, "meta.json");
		const draftPath = join(folderPath, "draft.md");
		if (!existsSync(metaPath) || !existsSync(draftPath)) return null;

		try {
			const entry = JSON.parse(readFileSync(metaPath, "utf-8")) as DraftIndexEntry;
			const content = readFileSync(draftPath, "utf-8");
			return { entry, content };
		} catch {
			return null;
		}
	}

	/** Rebuild the search index from scratch by scanning all draft folders */
	private _rebuildSearchIndex(): void {
		this._searchIdx = emptyIndex();
		for (const entry of this._index) {
			const folderPath = join(this._outDir, entry.folderName);
			const draftPath = join(folderPath, "draft.md");
			if (!existsSync(draftPath)) continue;
			try {
				const content = readFileSync(draftPath, "utf-8");
				const body = content.replace(/^# .+?\n(?:>.+?\n)*\n?---\n*/s, "");
				indexDoc(this._searchIdx, entry.id, entry.title, body, entry.sourceType, entry.tags,
					undefined, entry.projectDir, entry.sessionId, entry.sessionName, entry.model);
			} catch { /* skip corrupt files */ }
		}
		writeSearchIndex(this._outDir, this._searchIdx);
	}

	/** Export a single draft as a standalone markdown file with YAML front matter */
	async exportDraft(id: string): Promise<{ path: string; content: string } | null> {
		const draft = await this.get(id);
		if (!draft) return null;

		const e = draft.entry;
		const meta = [
			"---",
			`title: "${e.title.replace(/"/g, "\\\"")}"`,
			`source_type: ${e.sourceType}`,
			e.sourceUrl ? `source_url: ${e.sourceUrl}` : "",
			`created: ${e.createdAt}`,
			e.tags.length ? `tags: [${e.tags.join(", ")}]` : "",
			e.projectDir ? `project: ${e.projectDir}` : "",
			e.sessionId ? `session: ${e.sessionId}` : "",
			e.sessionName ? `session_name: ${e.sessionName}` : "",
			e.model ? `model: ${e.model}` : "",
			"---",
			"",
		].filter(Boolean).join("\n");

		const content = meta + draft.content;
		const name = generateSlug(e.title) || "draft";
		const outPath = join(this._outDir, `${name}-export.md`);
		writeFileSync(outPath, content, "utf-8");
		return { path: outPath, content };
	}

	/** Bundle multiple drafts into one research brief file */
	async bundle(draftIds: string[], briefTitle: string): Promise<{ path: string; count: number }> {
		const drafts: Draft[] = [];
		for (const id of draftIds) {
			const d = await this.get(id);
			if (d) drafts.push(d);
		}

		const sections = drafts.map((d, i) => {
			const e = d.entry;
			const metaParts = [
				`**Source:** ${e.sourceType}`,
				`**Date:** ${e.createdAt.slice(0, 10)}`,
				e.model ? `**Model:** ${e.model}` : "",
				e.projectDir ? `**Project:** ${e.projectDir.split(/[/\\]/).pop()}` : "",
				e.sourceUrl ? `URL: ${e.sourceUrl}` : "",
			].filter(Boolean);
			return [
				`## ${i + 1}. ${e.title}`,
				`> ${metaParts.join(" · ")}`,
				e.tags.length ? `> **Tags:** ${e.tags.join(", ")}` : "",
				"",
				d.content.replace(/^#[^\n]*\n(?:>[^\n]*\n)*\n?---\n*/s, ""),
				"",
				"---",
				"",
			].filter(Boolean).join("\n");
		});

		const full = [
			`# ${briefTitle}`,
			`> Bundled research brief from ${drafts.length} draft(s) · ${nowISO().slice(0, 10)}`,
			"",
			"---",
			"",
			...sections,
			`*Bundled by pi-source-drafts on ${nowISO()}*`,
		].join("\n");

		const name = generateSlug(briefTitle) || "research-brief";
		const outPath = join(this._outDir, `${name}-brief.md`);
		writeFileSync(outPath, full, "utf-8");
		return { path: outPath, count: drafts.length };
	}

	/** Stats for model context injection */
	async getStats(): Promise<{ total: number; byType: Record<string, number>; oldest: string; newest: string }> {
		this._guard();
		const byType: Record<string, number> = {};
		for (const e of this._index) {
			byType[e.sourceType] = (byType[e.sourceType] ?? 0) + 1;
		}
		return {
			total: this._index.length,
			byType,
			oldest: this._index.at(-1)?.createdAt ?? "",
			newest: this._index[0]?.createdAt ?? "",
		};
	}

	/** Compact index: re-index from files, removing orphaned entries. Call after mass-delete. */
	async compactIndex(): Promise<{ removed: number }> {
		this._guard();
		const before = Object.keys(this._searchIdx.docs).length;
		this._rebuildSearchIndex();
		const after = Object.keys(this._searchIdx.docs).length;
		return { removed: before - after };
	}
}

// Singleton
export const draftStore = new DraftStore();
