export type CoalescingWorker<K, V> = {
  /** Latest wins per key; a burst collapses to the fewest runs possible. */
  enqueue(key: K, value: V): void;
  /** Resolves when the key (or every key, when omitted) has nothing queued, pending, or active. */
  drain(key?: K): Promise<void>;
  /** Stop scheduling; settles every waiter. */
  dispose(): void;
};

type Cell<V> = { current?: { value: V }; queued: boolean; active: boolean };

/**
 * Latest-wins-per-key background work, in plain TS. JS runs one thread, so
 * the merge is atomic by construction: no locks, no transactions.
 *
 * At most one run per key is ever in flight. A failure reports through
 * onError and the key settles, unless a newer value arrived meanwhile, in
 * which case it runs next. drain() replaces timing-sensitive sleeps in tests.
 */
export function createCoalescingWorker<K, V>(options: {
  merge: (current: V, next: V) => V;
  process: (key: K, value: V) => Promise<void> | void;
  onError?: (key: K, error: unknown) => void;
}): CoalescingWorker<K, V> {
  const states = new Map<K, Cell<V>>();
  const waiters = new Map<K | null, Set<() => void>>();
  let disposed = false;

  function settled(state: Cell<V>): boolean {
    return !state.queued && !state.active && state.current === undefined;
  }

  function notify(key: K): void {
    const state = states.get(key);
    if (state && settled(state)) states.delete(key);
    const keyWaiters = waiters.get(key);
    if (keyWaiters && !states.has(key)) {
      waiters.delete(key);
      for (const resolve of keyWaiters) resolve();
    }
    if (states.size === 0) {
      const all = waiters.get(null);
      if (all) {
        waiters.delete(null);
        for (const resolve of all) resolve();
      }
    }
  }

  function schedule(key: K): void {
    const state = states.get(key);
    if (!state || state.active || disposed) return;
    // Claim synchronously so a burst collapses, but start on a microtask so
    // values enqueued in the same macrotask merge before the first run.
    state.active = true;
    void Promise.resolve().then(() => void pump(key));
  }

  async function pump(key: K): Promise<void> {
    try {
      for (;;) {
        if (disposed) break;
        const cell = states.get(key);
        const boxed = cell?.current;
        if (!cell || boxed === undefined) break;
        cell.current = undefined;
        cell.queued = false;
        try {
          await options.process(key, boxed.value);
        } catch (error) {
          try {
            options.onError?.(key, error);
          } catch {
            // A failing reporter must not wedge the key.
          }
        }
      }
    } finally {
      // Synchronous tail: nothing can interleave, so a value that landed
      // mid-run is either picked up by the loop above or re-scheduled here.
      const state = states.get(key);
      if (state && state.current !== undefined && !disposed) {
        state.active = false;
        state.queued = true;
        schedule(key);
      } else {
        if (state) {
          state.active = false;
          state.queued = false;
        }
        notify(key);
      }
    }
  }

  return {
    enqueue(key, value) {
      if (disposed) return;
      let state = states.get(key);
      if (!state) {
        state = { current: undefined, queued: false, active: false };
        states.set(key, state);
      }
      state.current =
        state.current === undefined ? { value } : { value: options.merge(state.current.value, value) };
      state.queued = true;
      schedule(key);
    },
    drain(key?: K): Promise<void> {
      if (disposed) return Promise.resolve();
      if (key === undefined) {
        if (states.size === 0) return Promise.resolve();
      } else {
        const state = states.get(key);
        if (!state || settled(state)) return Promise.resolve();
      }
      return new Promise((resolve) => {
        const mapKey = (key ?? null) as K | null;
        let set = waiters.get(mapKey);
        if (!set) {
          set = new Set();
          waiters.set(mapKey, set);
        }
        set.add(resolve as () => void);
      });
    },
    dispose() {
      disposed = true;
      states.clear();
      for (const set of waiters.values()) for (const resolve of set) resolve();
      waiters.clear();
    },
  };
}
