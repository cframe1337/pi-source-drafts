import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendOp, readOps, opsSincePosition, journalLength,
  writeSnapshot, readSnapshot, detectFormat, writeFormat,
  LATEST_FORMAT,
  type JournalOp, type SaveOp, type DeleteOp, type UpdateOp,
  type DraftMeta, type SnapshotData,
} from "./journal.ts";

function tmpJournal(name: string): string {
  const dir = join(tmpdir(), `journal-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "journal.jsonl");
}

function tmpSnapshot(name: string): string {
  const dir = join(tmpdir(), `snap-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "index.snapshot");
}

function tmpDir(name: string): string {
  const dir = join(tmpdir(), `fmt-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSave(id: string, overrides?: Partial<SaveOp>): SaveOp {
  return {
    op: "save",
    id,
    ts: Date.now(),
    content: "# " + id,
    meta: { title: id, sourceType: "user_source", tags: [], createdAt: new Date().toISOString() },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("journal append / read / replay", () => {
  let path: string;

  beforeEach(() => { path = tmpJournal("basic"); });

  test("appendOp writes one JSON line", () => {
    const op: SaveOp = makeSave("doc-1");
    appendOp(path, op);
    const data = readFileSync(path, "utf8");
    expect(data.endsWith("\n")).toBe(true);
    expect(data.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("readOps returns all ops in order", () => {
    appendOp(path, makeSave("a"));
    appendOp(path, makeSave("b"));
    appendOp(path, makeSave("c"));
    const ops = readOps(path);
    expect(ops).toHaveLength(3);
    expect((ops[0] as SaveOp).id).toBe("a");
    expect((ops[1] as SaveOp).id).toBe("b");
    expect((ops[2] as SaveOp).id).toBe("c");
  });

  test("readOps with fromPosition skips lines", () => {
    appendOp(path, makeSave("a"));
    appendOp(path, makeSave("b"));
    appendOp(path, makeSave("c"));
    const ops = readOps(path, 1);
    expect(ops).toHaveLength(2);
    expect((ops[0] as SaveOp).id).toBe("b");
  });

  test("opsSincePosition returns only ops after position", () => {
    appendOp(path, makeSave("a"));
    const pos = journalLength(path);
    appendOp(path, makeSave("b"));
    appendOp(path, makeSave("c"));
    const ops = opsSincePosition(path, pos);
    expect(ops).toHaveLength(2);
    expect((ops[0] as SaveOp).id).toBe("b");
  });

  test("journalLength counts lines", () => {
    expect(journalLength(path)).toBe(0);
    appendOp(path, makeSave("a"));
    expect(journalLength(path)).toBe(1);
    appendOp(path, makeSave("b"));
    expect(journalLength(path)).toBe(2);
  });

  test("readOps on missing file returns empty array", () => {
    expect(readOps("/nonexistent/path")).toEqual([]);
  });

  test("handles delete ops", () => {
    const del: DeleteOp = { op: "delete", id: "doc-1", ts: Date.now() };
    appendOp(path, makeSave("doc-1"));
    appendOp(path, del);
    const ops = readOps(path);
    expect(ops).toHaveLength(2);
    expect((ops[1] as DeleteOp).op).toBe("delete");
    expect((ops[1] as DeleteOp).id).toBe("doc-1");
  });

  test("handles update ops", () => {
    const upd: UpdateOp = { op: "update", id: "doc-1", ts: Date.now(), meta: { tags: ["updated"] } };
    appendOp(path, updateOp("doc-1", ["updated"]));
    const ops = readOps(path);
    expect((ops[0] as UpdateOp).op).toBe("update");
    expect((ops[0] as UpdateOp).meta.tags).toEqual(["updated"]);
  });

  test("skips corrupt lines", () => {
    appendOp(path, makeSave("a"));
    writeFileSync(path, readFileSync(path, "utf8") + "not-json\n", "utf8");
    appendOp(path, makeSave("c"));
    const ops = readOps(path);
    expect(ops).toHaveLength(2);
  });
});

function updateOp(id: string, tags: string[]): UpdateOp {
  return { op: "update", id, ts: Date.now(), meta: { tags } };
}

describe("snapshot", () => {
  test("write + read round-trip", () => {
    const path = tmpSnapshot("roundtrip");
    const data: SnapshotData = {
      format: 2,
      journalPosition: 10,
      ts: Date.now(),
      docs: [{ id: "doc-1", meta: { title: "Test", sourceType: "user_source", tags: ["a"], createdAt: "2026-01-01" }, sections: [] }],
      words: [{ term: "test", postings: [{ docId: "doc-1", count: 1, inTitle: true }] }],
    };
    writeSnapshot(path, data);
    const read = readSnapshot(path);
    expect(read).not.toBeNull();
    expect(read!.format).toBe(2);
    expect(read!.journalPosition).toBe(10);
    expect(read!.docs).toHaveLength(1);
    expect(read!.docs[0].id).toBe("doc-1");
    expect(read!.words).toHaveLength(1);
    expect(read!.words[0].term).toBe("test");
  });

  test("readSnapshot returns null on missing file", () => {
    expect(readSnapshot("/nonexistent.snap")).toBeNull();
  });

  test("readSnapshot returns null on bad magic", () => {
    const path = tmpSnapshot("badmagic");
    writeFileSync(path, "trashdata", "utf8");
    expect(readSnapshot(path)).toBeNull();
  });
});

describe("format detection", () => {
  test("detectFormat returns 1 if no index.format", () => {
    const dir = tmpDir("noversion");
    expect(detectFormat(dir)).toBe(1);
  });

  test("detectFormat reads version", () => {
    const dir = tmpDir("version");
    writeFormat(dir);
    expect(detectFormat(dir)).toBe(LATEST_FORMAT);
  });
});
