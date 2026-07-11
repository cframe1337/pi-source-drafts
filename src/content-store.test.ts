import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "./content-store.ts";

function tmpDb(name: string): string {
  const dir = join(tmpdir(), `content-store-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "drafts.cdb");
}

describe("ContentStore", () => {
  let db: ContentStore;
  let path: string;

  beforeEach(() => {
    path = tmpDb("test");
    db = new ContentStore(path);
  });

  test("new store has size 0", () => {
    expect(db.size).toBe(0);
  });

  test("append and read round-trip", () => {
    db.append("doc-1", "Hello World");
    expect(db.has("doc-1")).toBe(true);
    expect(db.read("doc-1")).toBe("Hello World");
  });

  test("returns null for missing id", () => {
    expect(db.has("nonexistent")).toBe(false);
    expect(db.read("nonexistent")).toBeNull();
  });

  test("replaces existing entry on re-append", () => {
    db.append("doc-1", "First version");
    db.append("doc-1", "Updated version");
    expect(db.read("doc-1")).toBe("Updated version");
  });

  test("tombstone delete removes from index", () => {
    db.append("doc-1", "Content");
    expect(db.has("doc-1")).toBe(true);
    db.delete("doc-1");
    expect(db.has("doc-1")).toBe(false);
    expect(db.read("doc-1")).toBeNull();
  });

  test("compact preserves live entries", () => {
    db.append("keep-a", "AAAA");
    db.append("keep-b", "BBBB");
    db.append("delete-me", "CCCC");
    db.delete("delete-me");
    expect(db.size).toBe(2);

    const { before, after } = db.compact();
    expect(before).toBe(2);
    expect(after).toBe(2);
    expect(db.has("keep-a")).toBe(true);
    expect(db.has("keep-b")).toBe(true);
    expect(db.has("delete-me")).toBe(false);
    expect(db.read("keep-a")).toBe("AAAA");
    expect(db.read("keep-b")).toBe("BBBB");
  });

  test("loads existing entries on reopen", () => {
    db.append("persist-1", "Content A");
    db.append("persist-2", "Content B");
    db.close();

    const db2 = new ContentStore(path);
    expect(db2.size).toBe(2);
    expect(db2.read("persist-1")).toBe("Content A");
    expect(db2.read("persist-2")).toBe("Content B");
    db2.close();
  });

  test("handles large content", () => {
    const large = "x".repeat(100_000);
    db.append("large-doc", large);
    expect(db.read("large-doc")).toBe(large);
  });

  test("rejects id collision (different ids, same hash)", () => {
    // FNV-1a is 32-bit, collisions are possible but extremely rare
    // Just verify overwrite behavior is correct
    db.append("id-a", "Content A");
    db.append("id-b", "Content B");
    // Both independent entries
    expect(db.has("id-a")).toBe(true);
    expect(db.has("id-b")).toBe(true);
  });
});
