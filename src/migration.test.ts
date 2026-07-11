import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStore } from "./draft-store.ts";

function tmpV1Dir(name: string): string {
  const dir = join(tmpdir(), `migration-v1-${name}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createV1Draft(outDir: string, folderName: string, title: string, body: string) {
  const folderPath = join(outDir, folderName);
  mkdirSync(folderPath, { recursive: true });

  const header = [
    `# ${title}`,
    "> **Source:** user_source · **Date:** 2026-01-01T00:00:00.000Z",
    "> **Tags:** test, v1",
    "",
    "---",
    "",
  ].join("\n");

  writeFileSync(join(folderPath, "draft.md"), header + body, "utf-8");
  writeFileSync(join(folderPath, "meta.json"), JSON.stringify({
    id: folderName,
    title,
    sourceType: "user_source",
    tags: ["test", "v1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    folderName,
    projectDir: "/test-project",
    sessionId: "sess-001",
    sessionName: "Test Session",
    model: "test/model",
  }, null, 2), "utf-8");
}

describe("migration from v0.1", () => {
  test("detects and migrates v0.1 format on init", async () => {
    const dir = tmpV1Dir("detect");

    // Create v0.1 index.json with 2 entries
    const index = [
      { id: "src-user-20260101T000000000Z-test-v1-a1b2", title: "Draft A", sourceType: "user_source", tags: ["test"], createdAt: "2026-01-01T00:00:00.000Z", folderName: "src-user-20260101T000000000Z-test-v1-a1b2", projectDir: "/test-project", sessionId: "sess-001", sessionName: "Test Session", model: "test/model" },
      { id: "src-user-20260102T000000000Z-draft-b-c3d4", title: "Draft B", sourceType: "web_search", tags: ["test", "web"], createdAt: "2026-01-02T00:00:00.000Z", folderName: "src-user-20260102T000000000Z-draft-b-c3d4", projectDir: "/test-project", sessionId: "sess-001", sessionName: "Test Session", model: "test/model" },
    ];
    writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2), "utf-8");

    createV1Draft(dir, "src-user-20260101T000000000Z-test-v1-a1b2", "Draft A", "Content of draft A with some searchable text.");
    createV1Draft(dir, "src-user-20260102T000000000Z-draft-b-c3d4", "Draft B", "Content of draft B with benchmark results.");

    const store = new DraftStore();
    await store.init(dir);

    const stats = await store.getStats();
    expect(stats.total).toBe(2);
    expect(stats.byType.user_source).toBe(1);
    expect(stats.byType.web_search).toBe(1);

    expect(existsSync(join(dir, "index.json"))).toBe(false);
    expect(existsSync(join(dir, "search.idx"))).toBe(false);
    expect(existsSync(join(dir, "index.format"))).toBe(true);
    expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);

    const a = await store.get("src-user-20260101T000000000Z-test-v1-a1b2");
    expect(a).not.toBeNull();
    expect(a!.entry.title).toBe("Draft A");
    expect(a!.content).toContain("searchable text");

    const b = await store.get("src-user-20260102T000000000Z-draft-b-c3d4");
    expect(b).not.toBeNull();
    expect(b!.entry.title).toBe("Draft B");
    expect(b!.content).toContain("benchmark");

    const searchResults = await store.search("benchmark");
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].entry.title).toBe("Draft B");
  });

  test("does not migrate if not v0.1 format", async () => {
    const dir = tmpV1Dir("skip");
    const store = new DraftStore();
    await store.init(dir);
    const stats = await store.getStats();
    expect(stats.total).toBe(0);
  });

  test("survives corrupt v0.1 index.json", async () => {
    const dir = tmpV1Dir("corrupt");
    writeFileSync(join(dir, "index.json"), "corrupt-json", "utf-8");
    const store = new DraftStore();
    await store.init(dir);
    const stats = await store.getStats();
    expect(stats.total).toBe(0);
  });
});
