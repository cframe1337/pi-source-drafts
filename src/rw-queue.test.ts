import { describe, expect, test, beforeEach } from "bun:test";
import { WriteQueue } from "./rw-queue.ts";

describe("WriteQueue", () => {
  let queue: WriteQueue;

  beforeEach(() => {
    queue = new WriteQueue();
  });

  test("executes tasks in FIFO order", async () => {
    const order: number[] = [];
    const p1 = queue.enqueue(async () => { order.push(1); });
    const p2 = queue.enqueue(async () => { order.push(2); });
    const p3 = queue.enqueue(async () => { order.push(3); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("waits for async task to complete before next", async () => {
    const order: number[] = [];
    queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    queue.enqueue(async () => { order.push(2); });
    await new Promise(r => setTimeout(r, 30));
    expect(order).toEqual([1, 2]);
  });

  test("continues after error in task", async () => {
    const order: number[] = [];
    const p1 = queue.enqueue(async () => { throw new Error("fail"); });
    const p2 = queue.enqueue(async () => { order.push(2); });

    await expect(p1).rejects.toThrow("fail");
    await p2;
    expect(order).toEqual([2]);
  });

  test("returns value from task", async () => {
    const result = await queue.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  test("handles concurrent enqueue calls", async () => {
    let counter = 0;
    const tasks = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue(async () => {
        const val = counter;
        await new Promise(r => setTimeout(r, 1));
        counter = val + 1;
      })
    );
    await Promise.all(tasks);
    expect(counter).toBe(10);
  });
});
