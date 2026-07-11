import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";

export type SourceType = "web_search" | "fetch_content" | "user_source" | "user_news" | "code_snippet";

export interface DraftMeta {
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
  tags: string[];
  createdAt: string;
  projectDir?: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
}

export interface SectionEntry {
  heading: string;
  body: string;
}

export interface SaveOp {
  op: "save";
  id: string;
  ts: number;
  content: string;
  meta: DraftMeta;
  hash?: string;
  sections?: SectionEntry[];
}

export interface DeleteOp {
  op: "delete";
  id: string;
  ts: number;
}

export interface UpdateOp {
  op: "update";
  id: string;
  ts: number;
  meta: Partial<DraftMeta>;
}

export type JournalOp = SaveOp | DeleteOp | UpdateOp;

export const LATEST_FORMAT = 2;

export interface SnapshotData {
  format: number;
  journalPosition: number;
  ts: number;
  docs: Array<{
    id: string;
    meta: DraftMeta;
    sections: SectionEntry[];
  }>;
  words: Array<{
    term: string;
    postings: Array<{ docId: string; count: number; inTitle: boolean }>;
  }>;
  hashes: Array<{ hash: string; docId: string }>;
}

export function detectFormat(outDir: string): number {
  const formatPath = `${outDir}/index.format`;
  if (!existsSync(formatPath)) return 1;
  const v = readFileSync(formatPath, "utf8").trim();
  const n = parseInt(v, 10);
  return isNaN(n) ? 1 : n;
}

export function writeFormat(outDir: string): void {
  writeFileSync(`${outDir}/index.format`, String(LATEST_FORMAT), "utf8");
}

export function appendOp(journalPath: string, op: JournalOp): void {
  appendFileSync(journalPath, JSON.stringify(op) + "\n");
}

export function readOps(journalPath: string, fromPosition?: number): JournalOp[] {
  if (!existsSync(journalPath)) return [];
  const data = readFileSync(journalPath, "utf8");
  const lines = data.split("\n").filter(Boolean);
  const start = fromPosition !== undefined ? fromPosition : 0;
  const ops: JournalOp[] = [];
  for (let i = start; i < lines.length; i++) {
    try {
      ops.push(JSON.parse(lines[i]));
    } catch {
      // skip corrupt lines
    }
  }
  return ops;
}

export function opsSincePosition(journalPath: string, position: number): JournalOp[] {
  return readOps(journalPath, position);
}

export function journalLength(journalPath: string): number {
  if (!existsSync(journalPath)) return 0;
  const data = readFileSync(journalPath, "utf8");
  return data.split("\n").filter(Boolean).length;
}

const SNAPSHOT_MAGIC = "PISNAP02";

export function writeSnapshot(path: string, data: SnapshotData): void {
  const buf = Buffer.from(JSON.stringify(data), "utf8");
  const header = Buffer.alloc(16);
  header.write(SNAPSHOT_MAGIC, 0, 8, "utf8");
  header.writeUInt32BE(buf.length, 8);
  header.writeUInt32BE(1, 12);
  writeFileSync(path, Buffer.concat([header, buf]));
}

export function readSnapshot(path: string): SnapshotData | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path);
  const magic = raw.toString("utf8", 0, 8);
  if (magic !== SNAPSHOT_MAGIC) return null;
  const dataLen = raw.readUInt32BE(8);
  const json = raw.toString("utf8", 16, 16 + dataLen);
  return JSON.parse(json);
}

export function deleteSnapshot(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
