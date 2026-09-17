import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { probePort } from "./port-probe";

describe("probePort", () => {
  it("reports open for a listening port and closed after shutdown", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port as number;
    expect(await probePort(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probePort(port)).toBe(false);
  });

  it("reports closed for a port nothing listens on", async () => {
    expect(await probePort(1, 500)).toBe(false);
  });
});
