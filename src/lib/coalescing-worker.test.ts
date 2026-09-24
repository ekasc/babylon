import { describe, expect, it } from "vitest";
import { createCoalescingWorker } from "./coalescing-worker";

describe("coalescing worker", () => {
  it("collapses a synchronous burst into one run with the merged value", async () => {
    const seen: string[][] = [];
    const worker = createCoalescingWorker<string, string[]>({
      merge: (current, next) => [...current, ...next],
      process: (key, value) => void seen.push([key, value.join(",")]),
    });
    for (let i = 0; i < 20; i++) worker.enqueue("tasks", [`e${i}`]);
    await worker.drain("tasks");
    expect(seen.length).toBe(1);
    expect(seen[0]?.[1]).toBe(Array.from({ length: 20 }, (_, i) => `e${i}`).join(","));
    worker.dispose();
  });

  it("processes spaced values in order, one run each", async () => {
    const seen: string[] = [];
    const worker = createCoalescingWorker<string, string>({
      merge: (_, next) => next,
      process: (_, value) => void seen.push(value),
    });
    worker.enqueue("k", "a");
    await worker.drain("k");
    worker.enqueue("k", "b");
    await worker.drain("k");
    expect(seen).toEqual(["a", "b"]);
    worker.dispose();
  });

  it("reports failures and still runs a newer arrival", async () => {
    const errors: unknown[] = [];
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const worker = createCoalescingWorker<string, string>({
      merge: (_, next) => next,
      process: (_, value) => {
        calls += 1;
        seen.push(value);
        if (calls === 1) return gate.then(() => Promise.reject(new Error("boom")));
        return Promise.resolve();
      },
      onError: (_, error) => void errors.push(error),
    });
    worker.enqueue("k", "first");
    await Promise.resolve();
    worker.enqueue("k", "second");
    release();
    await worker.drain("k");
    expect(seen).toEqual(["first", "second"]);
    expect(errors.length).toBe(1);
    worker.dispose();
  });

  it("drain waits for in-flight work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let done = false;
    const worker = createCoalescingWorker<string, string>({
      merge: (_, next) => next,
      process: () => gate.then(() => void (done = true)),
    });
    worker.enqueue("k", "v");
    let drained = false;
    const waiting = worker.drain("k").then(() => void (drained = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(drained).toBe(false);
    release();
    await waiting;
    expect(done).toBe(true);
    expect(drained).toBe(true);
    worker.dispose();
  });

  it("drains every key at once and stops on dispose", async () => {
    const seen: string[] = [];
    const worker = createCoalescingWorker<string, string>({
      merge: (_, next) => next,
      process: (_, value) => void seen.push(value),
    });
    worker.enqueue("a", "1");
    worker.enqueue("b", "2");
    await worker.drain();
    expect(seen.sort()).toEqual(["1", "2"]);
    worker.dispose();
    worker.enqueue("a", "3");
    await worker.drain();
    expect(seen.sort()).toEqual(["1", "2"]);
  });

  it("merges pairwise across arrivals", async () => {
    const merges: [number, number][] = [];
    const worker = createCoalescingWorker<string, number>({
      merge: (current, next) => {
        merges.push([current, next]);
        return current + next;
      },
      process: () => {},
    });
    worker.enqueue("k", 1);
    worker.enqueue("k", 2);
    worker.enqueue("k", 4);
    await worker.drain("k");
    expect(merges).toEqual([
      [1, 2],
      [3, 4],
    ]);
    worker.dispose();
  });
});
