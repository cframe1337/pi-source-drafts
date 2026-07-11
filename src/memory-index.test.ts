import { describe, expect, test, beforeEach } from "bun:test";
import { MemoryIndex } from "./memory-index.ts";
import type { SaveOp, DraftMeta } from "./journal.ts";

function saveOp(id: string, title: string, body: string, overrides?: Partial<DraftMeta>): SaveOp {
  return {
    op: "save",
    id,
    ts: Date.now(),
    content: body,
    meta: { title, sourceType: "user_source", tags: [], createdAt: new Date().toISOString(), ...overrides },
  };
}

describe("MemoryIndex", () => {
  let idx: MemoryIndex;

  beforeEach(() => {
    idx = new MemoryIndex();
  });

  describe("basic apply", () => {
    test("save adds doc", () => {
      idx.apply(saveOp("doc-1", "Hello World", "Hello World body"));
      expect(idx.totalDocs).toBe(1);
      expect(idx.hasDoc("doc-1")).toBe(true);
      expect(idx.getMeta("doc-1")?.title).toBe("Hello World");
    });

    test("delete removes doc", () => {
      idx.apply(saveOp("doc-1", "Title", "Body"));
      idx.apply({ op: "delete", id: "doc-1", ts: Date.now() });
      expect(idx.totalDocs).toBe(0);
      expect(idx.hasDoc("doc-1")).toBe(false);
    });

    test("update merges metadata", () => {
      idx.apply(saveOp("doc-1", "Title", "Body"));
      idx.apply({ op: "update", id: "doc-1", ts: Date.now(), meta: { tags: ["new-tag"] } });
      expect(idx.getMeta("doc-1")?.tags).toEqual(["new-tag"]);
    });

    test("save replaces existing doc", () => {
      idx.apply(saveOp("doc-1", "Old Title", "Old body"));
      idx.apply(saveOp("doc-1", "New Title", "New body"));
      expect(idx.totalDocs).toBe(1);
      expect(idx.getMeta("doc-1")?.title).toBe("New Title");
    });
  });

  describe("search basics", () => {
    beforeEach(() => {
      idx.apply(saveOp("search-1", "JavaScript Performance", "Benchmark results and optimization tips"));
      idx.apply(saveOp("search-2", "Python Basics", "Introduction to Python programming language"));
      idx.apply(saveOp("search-3", "TypeScript Guide", "TypeScript is JavaScript with types"));
    });

    test("finds docs by title", () => {
      const results = idx.search("javascript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.title).toBe("JavaScript Performance");
    });

    test("finds docs by body", () => {
      const results = idx.search("benchmark");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.entry.title === "JavaScript Performance")).toBe(true);
    });

    test("returns empty for no match", () => {
      expect(idx.search("xyznonexistent")).toHaveLength(0);
    });

    test("titles score higher than body matches", () => {
      const jsResults = idx.search("javascript");
      expect(jsResults.length).toBeGreaterThanOrEqual(2);
      expect(jsResults[0].entry.title).toBe("JavaScript Performance");
    });

    test("pagination works", () => {
      const all = idx.search("javascript");
      expect(all.length).toBeGreaterThanOrEqual(2);
      const first = idx.search("javascript", { limit: 1 });
      expect(first).toHaveLength(1);
      const second = idx.search("javascript", { limit: 1, offset: 1 });
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(all[1].id);
    });
  });

  describe("filtering", () => {
    test("filters by tags", () => {
      idx.apply(saveOp("tag-1", "Important Doc", "Content", { tags: ["security", "critical"] }));
      idx.apply(saveOp("tag-2", "Trivial Doc", "Content", { tags: ["wip"] }));
      const results = idx.search("doc", { tags: ["security"] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("tag-1");
    });

    test("filters by sourceType", () => {
      idx.apply(saveOp("st-1", "Web Result", "Content", { sourceType: "web_search" }));
      idx.apply(saveOp("st-2", "User Note", "Content", { sourceType: "user_source" }));
      const results = idx.search("content", { sourceType: "web_search" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("st-1");
    });
  });

  describe("context boosting", () => {
    test("current project adds +5", () => {
      idx.apply(saveOp("proj-1", "Project Doc", "Content", { projectDir: "/my-project" }));
      idx.apply(saveOp("proj-2", "Other Doc", "Content", { projectDir: "/other" }));
      const results = idx.search("doc", { currentProject: "/my-project" });
      expect(results[0].id).toBe("proj-1");
    });

    test("current session adds +10", () => {
      idx.apply(saveOp("sess-1", "Session Doc", "Content", { sessionId: "active-session" }));
      idx.apply(saveOp("sess-2", "Old Doc", "Content"));
      const results = idx.search("doc", { currentSession: "active-session" });
      expect(results[0].id).toBe("sess-1");
    });
  });

  describe("rebuild and hydrate", () => {
    test("rebuildFromOps builds index correctly", () => {
      const ops = [
        saveOp("r-1", "Rebuild Test", "Content for rebuild testing"),
        saveOp("r-2", "Second Doc", "More content"),
      ];
      const idx2 = new MemoryIndex();
      idx2.rebuildFromOps(ops);
      expect(idx2.totalDocs).toBe(2);
      expect(idx2.search("rebuild")).toHaveLength(1);
    });

    test("hydrate restores from snapshot", () => {
      idx.apply(saveOp("snap-1", "Snapshot Doc", "Test content", { tags: ["snap"] }));
      const snapData = {
        format: 2,
        journalPosition: 0,
        ts: Date.now(),
        docs: [
          { id: "snap-1", meta: idx.getMeta("snap-1")!, sections: idx.getSections("snap-1") },
        ],
        words: idx.snapshotWords,
      };

      const idx2 = new MemoryIndex();
      idx2.hydrate(snapData);
      expect(idx2.totalDocs).toBe(1);
      expect(idx2.hasDoc("snap-1")).toBe(true);
      expect(idx2.search("snapshot")).toHaveLength(1);
    });
  });

  describe("sections", () => {
    test("getSections returns stored sections", () => {
      const sections = [{ heading: "Chapter 1", body: "First chapter content" }];
      idx.apply({
        op: "save",
        id: "sec-2",
        ts: Date.now(),
        content: "Body content",
        meta: { title: "Sections Test 2", sourceType: "user_source", tags: [], createdAt: new Date().toISOString() },
        sections,
      });
      expect(idx.getSections("sec-2")).toEqual(sections);
    });
  });

  describe("edge cases", () => {
    test("empty query returns empty", () => {
      expect(idx.search("")).toHaveLength(0);
    });

    test("stop words are ignored", () => {
      idx.apply(saveOp("sw-1", "The and of", "the and of a an"));
      expect(idx.search("the")).toHaveLength(0);
    });

    test("totalDocs accurate after multiple operations", () => {
      idx.apply(saveOp("multi-1", "Doc A", "A body"));
      idx.apply(saveOp("multi-2", "Doc B", "B body"));
      expect(idx.totalDocs).toBe(2);
      idx.apply({ op: "delete", id: "multi-1", ts: Date.now() });
      expect(idx.totalDocs).toBe(1);
    });

    test("countBySourceType returns correct counts", () => {
      idx.apply(saveOp("ct-1", "Web", "Content", { sourceType: "web_search" }));
      idx.apply(saveOp("ct-2", "User", "Content", { sourceType: "user_source" }));
      idx.apply(saveOp("ct-3", "Code", "Content", { sourceType: "code_snippet" }));
      const counts = idx.countBySourceType();
      expect(counts.web_search).toBe(1);
      expect(counts.user_source).toBe(1);
      expect(counts.code_snippet).toBe(1);
      expect(Object.keys(counts).length).toBe(3);
    });
  });
});
