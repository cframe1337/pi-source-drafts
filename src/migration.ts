import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendOp, type SaveOp, type DraftMeta, type SectionEntry } from "./journal.ts";
import { splitIntoSections } from "./draft-store.ts";

export interface MigrationReport {
  migrated: number;
  skipped: number;
  oldFilesDeleted: string[];
}

export function detectV1Format(outDir: string): boolean {
  return existsSync(join(outDir, "index.json"));
}

export async function migrateV1ToV2(outDir: string): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: 0, skipped: 0, oldFilesDeleted: [] };
  const indexPath = join(outDir, "index.json");
  const journalPath = join(outDir, "journal.jsonl");

  if (!existsSync(indexPath)) return report;

  let entries: Array<Record<string, unknown>> = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return report;
  }

  for (const entry of entries) {
    const folderName = String(entry.folderName || "");
    const folderPath = join(outDir, folderName);
    const draftPath = join(folderPath, "draft.md");

    if (!existsSync(draftPath)) {
      report.skipped++;
      continue;
    }

    try {
      const content = readFileSync(draftPath, "utf-8");
      const body = content.replace(/^# .+?\n(?:>.+?\n)*\n?---\n*/s, "").trim();
      const meta: DraftMeta = {
        title: String(entry.title || ""),
        sourceType: (entry.sourceType as DraftMeta["sourceType"]) || "user_source",
        sourceUrl: entry.sourceUrl ? String(entry.sourceUrl) : undefined,
        tags: (entry.tags as string[]) || [],
        createdAt: String(entry.createdAt || new Date().toISOString()),
        projectDir: entry.projectDir ? String(entry.projectDir) : undefined,
        sessionId: entry.sessionId ? String(entry.sessionId) : undefined,
        sessionName: entry.sessionName ? String(entry.sessionName) : undefined,
        model: entry.model ? String(entry.model) : undefined,
      };
      const sections = splitIntoSections(body, meta.title);
      const id = String(entry.id || entry.folderName || "");
      const ts = new Date(meta.createdAt).getTime();

      const op: SaveOp = { op: "save", id, ts, content: body, meta, sections };
      appendOp(journalPath, op);
      report.migrated++;
    } catch {
      report.skipped++;
    }
  }

  const oldSearchIdx = join(outDir, "search.idx");
  if (existsSync(oldSearchIdx)) {
    rmSync(oldSearchIdx);
    report.oldFilesDeleted.push("search.idx");
  }
  if (existsSync(indexPath)) {
    rmSync(indexPath);
    report.oldFilesDeleted.push("index.json");
  }

  return report;
}
