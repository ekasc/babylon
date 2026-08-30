import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Parity guard between the thin-client facade (daemon-runtime) and the daemon
// server. The audit hypothesised that some RuntimeFacade methods (getStats,
// getRecaps, getTurnChanges, getTurnFileDiff) had no daemon handler. They do —
// every request the thin client sends is resolved by the daemon either via the
// pi.* switch, the explicit request.type if-chain, or the dispatchRequest core
// (task.* / contract.* / attention.* / ping). This test keeps that invariant:
// adding a facade method whose request has no daemon handler must fail here.

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const runtimeSrc = read("daemon-runtime.ts");
const serverSrc = read("daemon-server.ts");
const hostSrc = read("daemon-host.ts");
const facadeSrc = read("runtime-facade.ts");

// Every protocol message the thin client sends to the daemon.
const sent = [...runtimeSrc.matchAll(/client\.request\(\s*"([^"]+)"/g)].map((m) => m[1]);

// Every message the daemon server (or its dispatchRequest core) knows.
const piHandled = new Set([...serverSrc.matchAll(/case\s+"(pi\.[^"]+)"/g)].map((m) => m[1]));
const explicitHandled = new Set([...serverSrc.matchAll(/(?:\(request as any\)|request)\.type\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
const dispatchHandled = new Set([...hostSrc.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]));
const handled = new Set<string>([...piHandled, ...explicitHandled, ...dispatchHandled]);

// RuntimeFacade data methods (lifecycle subscriptions issue no request).
const facadeMethods = [...facadeSrc.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*)\(/gm)]
  .map((m) => m[1])
  .filter((m) => !m.startsWith("on"));

describe("RuntimeFacade <-> daemon parity", () => {
  it("every request the thin client sends is handled by the daemon", () => {
    const missing = sent.filter((t) => !handled.has(t));
    expect(missing, `unhandled daemon requests: ${missing.join(", ")}`).toEqual([]);
  });

  it("implements every RuntimeFacade data method in the thin client", () => {
    expect(facadeMethods.length).toBeGreaterThan(0);
    for (const m of facadeMethods) {
      expect(runtimeSrc, `daemon-runtime is missing facade method ${m}`).toContain(`async ${m}(`);
    }
  });
});
