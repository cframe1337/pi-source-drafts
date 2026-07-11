import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WriteQueue } from "./rw-queue.ts";
import { appendOp, readOps, opsSincePosition, readSnapshot, detectFormat, writeFormat, type DraftMeta, type SaveOp, type DeleteOp, type UpdateOp, type SectionEntry } from "./journal.ts";
import { MemoryIndex, type SearchOptions } from "./memory-index.ts";
import { scanSaveParams } from "./scanner.ts";
import { ContentStore } from "./content-store.ts";

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
  sessionName?: string;
  model?: string;
}

export interface SaveDraftParams {
  title: string;
  content: string;
  sourceType: SourceType;
  sourceUrl?: string;
  tags?: string[];
  sourceHash?: string;
  projectDir?: string;
  sessionId?: string;
  sessionName?: string;
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
  currentProject?: string;
  currentSession?: string;
}

function nowISO(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

function generateSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-zа-я0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40);
}

function folderName(sourceType: string, title: string): string {
  const ts = nowISO().replace(/[-:.]/g, "");
  const slug = generateSlug(title);
  return `src-${sourceType}-${ts}-${slug.slice(0, 24)}-${shortId()}`;
}

function metaToIndexEntry(id: string, folder: string, meta: DraftMeta): DraftIndexEntry {
  return {
    id,
    title: meta.title,
    sourceType: meta.sourceType,
    sourceUrl: meta.sourceUrl,
    tags: meta.tags,
    createdAt: meta.createdAt,
    folderName: folder,
    projectDir: meta.projectDir,
    sessionId: meta.sessionId,
    sessionName: meta.sessionName,
    model: meta.model,
  };
}

export function splitIntoSections(content: string, _title: string): { heading: string; body: string }[] {
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

export function getSectionBody(content: string, headingName: string): string {
  const sections = splitIntoSections(content, "");
  const match = sections.find(s => s.heading.trim() === headingName);
  return match ? match.body : "";
}

export class DraftStore {
  private writeQueue = new WriteQueue();
  private memoryIndex = new MemoryIndex();
  private contentStore: ContentStore | null = null;
  private _outDir = "";
  private initialized = false;

  /** @internal exposed for index.ts context injection */
  get outDir(): string {
    return this._outDir;
  }

  async init(outDir?: string): Promise<void> {
    if (this.initialized) return;
    this._outDir = outDir || join(homedir(), ".pi", "source-drafts");
    mkdirSync(this._outDir, { recursive: true });

    const journalPath = join(this._outDir, "journal.jsonl");
    const format = detectFormat(this._outDir);

    if (format === 1) {
      await this._migrateFromV1();
      writeFormat(this.outDir);
    }

    const snapshotPath = join(this.outDir, "index.snapshot");
    const snap = readSnapshot(snapshotPath);
    if (snap) {
      this.memoryIndex.hydrate(snap);
      const ops = opsSincePosition(journalPath, snap.journalPosition);
      for (const op of ops) this.memoryIndex.apply(op);
    } else {
      const ops = readOps(journalPath);
      for (const op of ops) this.memoryIndex.apply(op);
    }

    const cdbPath = join(this.outDir, "drafts.cdb");
    try {
      this.contentStore = new ContentStore(cdbPath);
    } catch (err) {
      // content store is optional; corrupt CDB gets overwritten on next save
    }

    this.initialized = true;
  }

  async save(params: SaveDraftParams): Promise<{ folderPath: string; deduped: boolean }> {
    return this.writeQueue.enqueue(async () => {
      if (params.sourceHash) {
        const existingId = this.memoryIndex.findByHash(params.sourceHash);
        if (existingId) {
          return { folderPath: join(this.outDir, existingId), deduped: true };
        }
      }

      const scanned = scanSaveParams({ content: params.content, meta: metaFromParams(params) });
      const folder = folderName(params.sourceType, params.title);
      const folderPath = join(this.outDir, folder);
      mkdirSync(folderPath, { recursive: true });

      const entry: DraftIndexEntry = {
        id: folder,
        title: scanned.meta.title || params.title,
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
        `# ${scanned.meta.title || params.title}`,
        `> **Source:** ${params.sourceType}${params.sourceUrl ? ` · **URL:** ${params.sourceUrl}` : ""} · **Date:** ${entry.createdAt}`,
        params.tags?.length ? `> **Tags:** ${params.tags.join(", ")}` : "",
        "",
        "---",
        "",
      ].filter(Boolean).join("\n");

      const draftContent = header + scanned.content;
      writeFileSync(join(folderPath, "draft.md"), draftContent, "utf-8");
      writeFileSync(join(folderPath, "meta.json"), JSON.stringify(entry, null, 2), "utf-8");

      const sections = splitIntoSections(scanned.content, scanned.meta.title || params.title);
      const saveOp: SaveOp = {
        op: "save",
        id: folder,
        ts: Date.now(),
        content: scanned.content,
        meta: {
          title: scanned.meta.title || params.title,
          sourceType: params.sourceType,
          sourceUrl: params.sourceUrl,
          tags: params.tags ?? [],
          createdAt: entry.createdAt,
          projectDir: params.projectDir,
          sessionId: params.sessionId,
          sessionName: params.sessionName,
          model: params.model,
        },
        hash: params.sourceHash,
        sections,
      };

      appendOp(join(this.outDir, "journal.jsonl"), saveOp);
      this.memoryIndex.apply(saveOp);
      try { this.contentStore?.append(folder, draftContent); } catch {}

      return { folderPath, deduped: false };
    });
  }

  async get(id: string): Promise<Draft | null> {
    const meta = this.memoryIndex.getMeta(id);
    if (!meta) {
      const allDocs = this.memoryIndex.getAllDocs();
      const matched = allDocs.find(d => d.startsWith(id) || id.startsWith(d));
      if (matched) {
        return this.get(matched);
      }
      const folder = this._findFolder(id);
      if (!folder) return null;
      return this._readDraftFromFolder(folder, join(this.outDir, folder));
    }

    const folderName = this._findFolder(id) || id;
    const folderPath = join(this.outDir, folderName);
    if (existsSync(folderPath) && statSync(folderPath).isDirectory()) {
      return this._readDraftFromFolder(folderName, folderPath);
    }

    try {
      const csContent = this.contentStore?.read(id);
      if (csContent) return { entry: metaToIndexEntry(id, folderName, meta), content: csContent };
    } catch {}

    return { entry: metaToIndexEntry(id, folderName, meta), content: "" };
  }

  async search(query: string): Promise<Draft[]>;
  async search(query: SearchQuery): Promise<Draft[]>;
  async search(query: string | SearchQuery): Promise<Draft[]> {
    const q: SearchQuery = typeof query === "string" ? { query } : query;
    const results = this.memoryIndex.search(q.query, {
      limit: q.limit || 50,
      tags: q.tags,
      sourceType: q.sourceType,
      currentProject: q.currentProject,
      currentSession: q.currentSession,
    });

    const drafts: Draft[] = [];
    for (const r of results) {
      const draft = await this.get(r.id);
      if (draft) drafts.push(draft);
    }
    return drafts;
  }

  async list(options?: { sourceType?: SourceType; tags?: string[] }): Promise<DraftIndexEntry[]> {
    const allIds = this.memoryIndex.getAllDocs();
    let entries: DraftIndexEntry[] = [];

    for (const id of allIds) {
      const meta = this.memoryIndex.getMeta(id);
      if (!meta) continue;
      if (options?.sourceType && meta.sourceType !== options.sourceType) continue;
      if (options?.tags?.length && !options.tags.some(t => meta.tags.includes(t))) continue;
      entries.push(metaToIndexEntry(id, id, meta));
    }

    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return entries;
  }

  async delete(id: string): Promise<boolean> {
    return this.writeQueue.enqueue(async () => {
      const meta = this.memoryIndex.getMeta(id);
      if (!meta) return false;

      const delOp: DeleteOp = { op: "delete", id, ts: Date.now() };
      appendOp(join(this.outDir, "journal.jsonl"), delOp);
      this.memoryIndex.apply(delOp);

      const folderPath = join(this.outDir, id);
      if (existsSync(folderPath) && statSync(folderPath).isDirectory()) {
        rmSync(folderPath, { recursive: true, force: true });
      }
      return true;
    });
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; oldest: string; newest: string }> {
    const allIds = this.memoryIndex.getAllDocs();
    let oldest = nowISO();
    let newest = "";
    const byType: Record<string, number> = {};

    for (const id of allIds) {
      const meta = this.memoryIndex.getMeta(id);
      if (!meta) continue;
      byType[meta.sourceType] = (byType[meta.sourceType] ?? 0) + 1;
      if (meta.createdAt < oldest) oldest = meta.createdAt;
      if (meta.createdAt > newest) newest = meta.createdAt;
    }

    return { total: allIds.length, byType, oldest, newest };
  }

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
    const outPath = join(this.outDir, `${name}-export.md`);
    writeFileSync(outPath, content, "utf-8");
    return { path: outPath, content };
  }

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
    const outPath = join(this.outDir, `${name}-brief.md`);
    writeFileSync(outPath, full, "utf-8");
    return { path: outPath, count: drafts.length };
  }

  async compactIndex(_options?: Record<string, unknown>): Promise<{ removed: number }> {
    const journalPath = join(this.outDir, "journal.jsonl");
    const snapshotPath = join(this.outDir, "index.snapshot");
    const pos = readOps(journalPath).length;
    const { writeSnapshot } = await import("./journal.ts");
    writeSnapshot(snapshotPath, {
      format: 2,
      journalPosition: pos,
      ts: Date.now(),
      docs: this.memoryIndex.snapshotDocs,
      words: this.memoryIndex.snapshotWords,
      hashes: this.memoryIndex.snapshotHashes,
    });
    return { removed: 0 };
  }

  async compactContent(): Promise<{ before: number; after: number } | null> {
    if (!this.contentStore) return null;
    return this.writeQueue.enqueue(async () => this.contentStore!.compact());
  }

  private _findFolder(id: string): string | null {
    const dir = this.outDir;
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir);
    const exact = entries.find(e => e === id);
    if (exact) return exact;
    const prefix = entries.find(e => e.includes(id) || id.includes(e));
    return prefix || null;
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

  private _migrateFromV1(): void {
    const journalPath = join(this.outDir, "journal.jsonl");
    const indexPath = join(this.outDir, "index.json");
    if (!existsSync(indexPath)) return;

    let oldIndex: DraftIndexEntry[] = [];
    try {
      oldIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      return;
    }

    for (const entry of oldIndex) {
      const folderPath = join(this.outDir, entry.folderName);
      const draftPath = join(folderPath, "draft.md");
      if (!existsSync(draftPath)) continue;
      try {
        const content = readFileSync(draftPath, "utf-8");
        const body = content.replace(/^# .+?\n(?:>.+?\n)*\n?---\n*/s, "").trim();
        const sections = splitIntoSections(body, entry.title);
        const saveOp: SaveOp = {
          op: "save",
          id: entry.id,
          ts: new Date(entry.createdAt).getTime(),
          content: body,
          meta: {
            title: entry.title,
            sourceType: entry.sourceType,
            sourceUrl: entry.sourceUrl,
            tags: entry.tags,
            createdAt: entry.createdAt,
            projectDir: entry.projectDir,
            sessionId: entry.sessionId,
            sessionName: entry.sessionName,
            model: entry.model,
          },
          sections,
        };
        appendOp(journalPath, saveOp);
      } catch {
        // skip corrupt entries
      }
    }

    const oldSearchIdx = join(this.outDir, "search.idx");
    if (existsSync(oldSearchIdx)) rmSync(oldSearchIdx);
    if (existsSync(indexPath)) rmSync(indexPath);
  }
}

function metaFromParams(params: SaveDraftParams): DraftMeta {
  return {
    title: params.title,
    sourceType: params.sourceType,
    sourceUrl: params.sourceUrl,
    tags: params.tags ?? [],
    createdAt: nowISO(),
    projectDir: params.projectDir,
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    model: params.model,
  };
}

export const draftStore = new DraftStore();
