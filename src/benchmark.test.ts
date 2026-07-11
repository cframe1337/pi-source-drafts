import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStore } from "./draft-store.ts";

const SIZES = [10, 50, 200];

function tmpBenchDir(name: string): string {
  const dir = join(tmpdir(), `bench-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function genDoc(n: number): { title: string; content: string } {
  const topics = [
    "JavaScript Performance", "Python Basics", "TypeScript Guide", "Rust Memory", "Go Concurrency",
    "React Hooks", "Vue Composition", "Angular Signals", "Svelte Stores", "Node Streams",
    "WebAssembly", "CSS Grid", "Flexbox Layout", "Async Await", "Promise Patterns",
    "Module Bundlers", "Tree Shaking", "Code Splitting", "Lazy Loading", "Memoization",
    "Virtual DOM", "Proxy Patterns", "Event Loop", "Microtasks", "Garbage Collection",
    "Web Workers", "Service Workers", "IndexedDB", "Local Storage", "Cache API",
    "HTTP Caching", "REST Design", "GraphQL Queries", "WebSockets", "SSE Events",
    "JWT Auth", "OAuth Flow", "CSRF Protection", "XSS Prevention", "CORS Headers",
    "Docker Compose", "K8s Pods", "CI CD Pipeline", "Git Hooks", "Code Review",
    "Test Coverage", "E2E Testing", "Unit Testing", "Integration Test", "Benchmark",
  ];
  const topic = topics[n % topics.length];
  const words = Array.from({ length: 50 + n % 100 }, (_, i) => `word_${i}_${topic.toLowerCase().replace(/\s/g, "_")}`);
  return {
    title: `${topic} — deep dive #${n}`,
    content: `## ${topic}\n\nThis document covers ${topic.toLowerCase()} in detail.\n\n${words.join(" ")}\n\n## References\n\nSee also: ${topics[(n + 1) % topics.length]}`,
  };
}

describe("benchmark: DraftStore v0.2", () => {
  test("save throughput", async () => {
    for (const N of SIZES) {
      const dir = tmpBenchDir(`save-${N}`);
      const store = new DraftStore();
      await store.init(dir);

      const start = performance.now();
      for (let i = 0; i < N; i++) {
        const doc = genDoc(i);
        await store.save({
          title: doc.title,
          content: doc.content,
          sourceType: i % 2 === 0 ? "web_search" : "fetch_content",
          tags: ["benchmark", `group-${i % 5}`],
          sourceHash: `hash-${i}`,
          projectDir: "/bench-project",
          sessionId: "bench-session",
        });
      }
      const elapsed = performance.now() - start;
      const perOp = (elapsed / N).toFixed(2);
      console.log(`  save(${N}): ${elapsed.toFixed(1)} ms total, ${perOp} ms/op`);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
    }
  });

  test("search across growing index", async () => {
    for (const N of SIZES) {
      const dir = tmpBenchDir(`search-${N}`);
      const store = new DraftStore();
      await store.init(dir);

      for (let i = 0; i < N; i++) {
        const doc = genDoc(i);
        await store.save({
          title: doc.title,
          content: doc.content,
          sourceType: "user_source",
          tags: ["bench"],
        });
      }

      const queries = ["deep dive", "JavaScript", "Docker", "benchmark", "Garbage Collection"];
      for (const q of queries) {
        const start = performance.now();
        const results = await store.search(q);
        const elapsed = performance.now() - start;
        console.log(`  search(${N}, "${q}"): ${elapsed.toFixed(3)} ms, ${results.length} results`);
      }
    }
  });

  test("delete performance", async () => {
    for (const N of SIZES) {
      const dir = tmpBenchDir(`delete-${N}`);
      const store = new DraftStore();
      await store.init(dir);

      for (let i = 0; i < N; i++) {
        const doc = genDoc(i);
        await store.save({
          title: doc.title,
          content: doc.content,
          sourceType: "user_source",
          tags: ["bench"],
        });
      }

      const before = await store.getStats();
      expect(before.total).toBe(N);

      const allDocs = await store.list();
      const start = performance.now();
      for (const entry of allDocs) {
        await store.delete(entry.id);
      }
      const elapsed = performance.now() - start;
      const perOp = (elapsed / N).toFixed(3);
      console.log(`  delete(${N}): ${elapsed.toFixed(1)} ms total, ${perOp} ms/op`);

      const after = await store.getStats();
      expect(after.total).toBe(0);
    }
  });

  test("startup from cold journal", async () => {
    for (const N of SIZES) {
      const dir = tmpBenchDir(`startup-${N}`);
      const store1 = new DraftStore();
      await store1.init(dir);

      for (let i = 0; i < N; i++) {
        const doc = genDoc(i);
        await store1.save({
          title: doc.title,
          content: doc.content,
          sourceType: "web_search",
          tags: ["bench"],
        });
      }

      const start = performance.now();
      const store2 = new DraftStore();
      await store2.init(dir);
      const elapsed = performance.now() - start;

      const stats = await store2.getStats();
      console.log(`  startup(${N}): ${elapsed.toFixed(1)} ms, ${stats.total} docs loaded`);

      expect(stats.total).toBe(N);

      // Quick search to verify index loaded correctly
      const results = await store2.search("deep dive");
      expect(results.length).toBeGreaterThan(0);
    }
  });
});
