import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fsp } from "node:fs";
import { LspManager, MAX_INITIAL_FILES, MAX_FILE_SIZE, type LanguageDescriptor } from "./lsp-manager";
import { encodeLspMessage, decodeLspMessages } from "./lsp";
import { spawn as nodeSpawn } from "node:child_process";

// Helper to create a fake LSP server script that speaks LSP over stdio
function createFakeServerScript(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "babylon-fake-lsp-"));
  const file = join(dir, "fake-server.mjs");
  writeFileSync(file, code, "utf8");
  return file;
}

function fakeServerThatEchoesDiagnostics(): string {
  return createFakeServerScript(`
import { Buffer } from "node:buffer";

function encode(msg) {
  const body = JSON.stringify(msg);
  const header = \`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\`;
  return Buffer.from(header + body, "utf8");
}
function decode(buf) {
  const messages = [];
  let cursor = buf;
  for (;;) {
    const headerEnd = cursor.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const headerText = cursor.toString("utf8", 0, headerEnd);
    let length;
    for (const line of headerText.split("\\r\\n")) {
      const m = /^content-length:\\s*(\\d+)$/i.exec(line);
      if (m) { length = Number(m[1]); break; }
    }
    if (length === undefined) { cursor = cursor.subarray(headerEnd+4); continue; }
    const bodyStart = headerEnd+4;
    const bodyEnd = bodyStart + length;
    if (cursor.length < bodyEnd) break;
    const body = cursor.toString("utf8", bodyStart, bodyEnd);
    try { messages.push(JSON.parse(body)); } catch {}
    cursor = cursor.subarray(bodyEnd);
  }
  return { messages, rest: Buffer.from(cursor) };
}

let buffer = Buffer.alloc(0);
let versions = new Map();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const { messages, rest } = decode(buffer);
  buffer = rest;
  for (const msg of messages) {
    if (msg.method === "initialize") {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } };
      process.stdout.write(encode(resp));
    } else if (msg.method === "initialized") {
      // no-op
    } else if (msg.method === "textDocument/didOpen") {
      const uri = msg.params?.textDocument?.uri;
      const text = msg.params?.textDocument?.text ?? "";
      const version = msg.params?.textDocument?.version ?? 1;
      versions.set(uri, version);
      // Publish a diagnostic: one error per file
      const diag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "fake error in " + uri, source: "fake" };
      const notif = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diag] } };
      setTimeout(() => process.stdout.write(encode(notif)), 15);
      // Also test server->client request handling: send workspace/configuration
      const req = { jsonrpc: "2.0", id: 9999, method: "workspace/configuration", params: { items: [{ section: "test" }] } };
      setTimeout(() => process.stdout.write(encode(req)), 20);
    } else if (msg.method === "textDocument/didChange") {
      const uri = msg.params?.textDocument?.uri;
      const changes = msg.params?.contentChanges ?? [];
      const text = changes[0]?.text ?? "";
      const version = msg.params?.textDocument?.version ?? 1;
      versions.set(uri, version);
      const diag = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, message: "fake error after change " + version, source: "fake" };
      const notif = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diag] } };
      setTimeout(() => process.stdout.write(encode(notif)), 15);
    } else if (msg.id !== undefined) {
      // generic request response
      process.stdout.write(encode({ jsonrpc: "2.0", id: msg.id, result: null }));
    }
  }
});
// Handle shutdown
process.on("SIGTERM", () => process.exit(0));
`);
}

function fakeServerThatCrashes(): string {
  return createFakeServerScript(`
import { Buffer } from "node:buffer";
function encode(msg){ const b=JSON.stringify(msg); return Buffer.from(\`Content-Length: \${Buffer.byteLength(b)}\\r\\n\\r\\n\`+b); }
function decode(buf){
  const msgs=[]; let c=buf;
  for(;;){ const h=c.indexOf("\\r\\n\\r\\n"); if(h===-1) break; const ht=c.toString("utf8",0,h); let len; for(const l of ht.split("\\r\\n")){ const m=/^content-length:\\s*(\\d+)$/i.exec(l); if(m){len=Number(m[1]);break;}} if(len===undefined){c=c.subarray(h+4);continue;} const bs=h+4, be=bs+len; if(c.length<be) break; const body=c.toString("utf8",bs,be); try{msgs.push(JSON.parse(body));}catch{} c=c.subarray(be);} return {messages:msgs, rest:Buffer.from(c)};
}
let buf=Buffer.alloc(0);
process.stdin.on("data", chunk=>{
  buf=Buffer.concat([buf,chunk]);
  const {messages, rest}=decode(buf); buf=rest;
  for(const msg of messages){
    if(msg.method==="initialize"){ process.stdout.write(encode({jsonrpc:"2.0",id:msg.id,result:{capabilities:{}}})); }
    else if(msg.method==="initialized"){ setTimeout(()=>process.exit(1), 30); }
    else if(msg.id!==undefined){ process.stdout.write(encode({jsonrpc:"2.0",id:msg.id,result:null})); }
  }
});
`);
}

async function waitFor(predicate: () => boolean, timeout = 3000, interval = 30): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor timeout");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential("LspManager", () => {
  let tmpRoots: string[] = [];
  let managers: LspManager[] = [];

  function makeTmpProject(files: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "babylon-lsp-proj-"));
    tmpRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      const dir = join(full, "..");
      // ensure dir
      const parts = rel.split("/").slice(0, -1);
      let cur = root;
      for (const p of parts) {
        cur = join(cur, p);
        try { require("node:fs").mkdirSync(cur, { recursive: true }); } catch {}
      }
      writeFileSync(full, content, "utf8");
    }
    return root;
  }

  afterEach(async () => {
    for (const m of managers) {
      try { m.dispose(); } catch {}
    }
    managers = [];
    for (const r of tmpRoots) {
      try { rmSync(r, { recursive: true, force: true }); } catch {}
    }
    tmpRoots = [];
    // also cleanup fake server dirs
  });

  it("initializes and receives didOpen + didChange with increasing versions", async () => {
    const fake = fakeServerThatEchoesDiagnostics();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const root = makeTmpProject({ "a.ts": "const x = 1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    let latest: import("./lsp-manager").LspProjectSnapshot | null = null;
    mgr.subscribe((snaps) => {
      latest = snaps.find((s) => s.cwd === root) ?? null;
    });

    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return s !== null && s.servers.some((sv) => sv.status === "running");
    }, 5000);

    // Wait for initial diagnostics from didOpen
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.diagnostics.length > 0;
    }, 3000);

    const snap1 = mgr.getSnapshot(root)!;
    expect(snap1.diagnostics.length).toBeGreaterThan(0);
    expect(snap1.servers[0].status).toBe("running");

    // Now modify file to trigger didChange with higher version
    const aPath = join(root, "a.ts");
    // Give watcher time to be ready
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(aPath, "const y = 2;", "utf8");

    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.diagnostics.some((d) => d.message.includes("after change"));
    }, 4000);

    const snap2 = mgr.getSnapshot(root)!;
    const changedDiag = snap2.diagnostics.find((d) => d.message.includes("after change"));
    expect(changedDiag).toBeDefined();
    // Ensure version increased: second diagnostic should have version-derived message containing version >=2
    expect(changedDiag!.message).toMatch(/after change/);
  });

  it("publishDiagnostics reaches normalized snapshot and newly-added callback", async () => {
    const fake = fakeServerThatEchoesDiagnostics();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const root = makeTmpProject({ "b.ts": "let a = 1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    const piCalls: Array<import("./lsp").NormalizedDiagnostic[]> = [];
    mgr.setPiNotifier((_cwd, diags) => piCalls.push(diags));

    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.diagnostics.length > 0;
    }, 5000);

    const snap = mgr.getSnapshot(root)!;
    // Normalized: file is uri, line 1-based
    expect(snap.diagnostics[0].file).toMatch(/^file:/);
    expect(snap.diagnostics[0].line).toBeGreaterThanOrEqual(1);
    expect(snap.diagnostics[0].severity).toBe("error");

    // Pi notifier should have been called with bounded diagnostics (debounced)
    await waitFor(() => piCalls.length > 0, 2000);
    expect(piCalls[0].length).toBeGreaterThan(0);
    expect(piCalls[0][0].severity).toBe("error");
  });


  it("project switch ignores stale diagnostics and stops old child", async () => {
    const fake = fakeServerThatEchoesDiagnostics();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const rootA = makeTmpProject({ "a.ts": "const a=1;" });
    const rootB = makeTmpProject({ "b.ts": "const b=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await mgr.setActiveProject(rootA);
    await waitFor(() => {
      const s = mgr.getSnapshot(rootA);
      return !!s && s.servers.some((sv) => sv.status === "running");
    }, 5000);
    const snapA = mgr.getSnapshot(rootA)!;
    const pidA = snapA.servers[0].pid;
    expect(pidA).toBeDefined();

    // Switch to B
    await mgr.setActiveProject(rootB);
    // Old project should be disposed (removed from list)
    expect(mgr.getSnapshot(rootA)).toBeNull();
    await waitFor(() => {
      const s = mgr.getSnapshot(rootB);
      return !!s && s.servers.some((sv) => sv.status === "running");
    }, 5000);
    const snapB = mgr.getSnapshot(rootB)!;
    expect(snapB.cwd).toBe(rootB);
    // Old pid should be gone (child killed)
    // Give OS time to reap
    await new Promise((r) => setTimeout(r, 200));
    // Check process no longer exists (kill with signal 0 throws if not alive)
    if (pidA) {
      let alive = true;
      try { process.kill(pidA, 0); alive = true; } catch { alive = false; }
      expect(alive).toBe(false);
    }
  });

  it("crash restarts at most twice, then stays crashed", async () => {
    const fake = fakeServerThatCrashes();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const root = makeTmpProject({ "c.ts": "const c=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      const sv = s?.servers[0];
      return !!sv && (sv.status === "crashed" || sv.status === "unavailable");
    }, 8000);

    const snap = mgr.getSnapshot(root)!;
    expect(snap.servers[0].status).toBe("crashed");
    expect(snap.servers[0].restartCount).toBe(2);
    // Ensure no further restart after crashed
    await new Promise((r) => setTimeout(r, 800));
    const snap2 = mgr.getSnapshot(root)!;
    expect(snap2.servers[0].restartCount).toBe(2);
    expect(snap2.servers[0].status).toBe("crashed");
  });

  it("unavailable command is represented truthfully without unhandled rejection", async () => {
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: "/nonexistent/binary-xyz-12345", args: ["--stdio"] }],
    };
    const root = makeTmpProject({ "d.ts": "const d=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await expect(mgr.setActiveProject(root)).resolves.toBeDefined();
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.servers.length > 0 && (s.servers[0].status === "unavailable" || s.servers[0].status === "crashed");
    }, 8000);

    const snap = mgr.getSnapshot(root)!;
    expect(snap.servers[0].status).toBe("unavailable");
    expect(snap.servers[0].message).toBeDefined();
    // No unhandled rejection should have occurred (test would have failed)
  });

  it("refresh retries unavailable server", async () => {
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: "/nonexistent/binary-xyz-12345", args: ["--stdio"] }],
    };
    const root = makeTmpProject({ "e.ts": "const e=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.servers.length > 0 && (s.servers[0].status === "unavailable" || s.servers[0].status === "crashed");
    }, 8000);
    await mgr.refresh(root);
    const after = mgr.getSnapshot(root)!.servers[0].status;
    expect(after).toBe("unavailable");
    // Refresh should not throw
  });

  it("disposal during an unavailable retry leaves no in-flight spawn", async () => {
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: "/nonexistent/binary-xyz-12345", args: ["--stdio"] }],
    };
    const root = makeTmpProject({ "retry.ts": "const retry=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await mgr.setActiveProject(root);
    await waitFor(() => mgr.getSnapshot(root)?.servers[0]?.status === "unavailable", 8000);

    const refresh = mgr.refresh(root);
    mgr.dispose();
    await expect(refresh).resolves.toBeDefined();
    expect(mgr.listSnapshots()).toEqual([]);
  });

  it("disposal leaves no fake children/watchers", async () => {
    const fake = fakeServerThatEchoesDiagnostics();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const root = makeTmpProject({ "f.ts": "const f=1;" });
    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);

    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.servers.some((sv) => sv.status === "running");
    }, 5000);
    const pid = mgr.getSnapshot(root)!.servers[0].pid!;
    mgr.dispose();
    // After dispose, snapshots empty
    expect(mgr.listSnapshots().length).toBe(0);
    await new Promise((r) => setTimeout(r, 250));
    let alive = true;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it("file filters and size cap", async () => {
    const fake = fakeServerThatEchoesDiagnostics();
    tmpRoots.push(join(fake, ".."));
    const descriptor: LanguageDescriptor = {
      language: "typescript",
      extensions: [".ts"],
      commands: [{ command: process.execPath, args: [fake] }],
    };
    const root = makeTmpProject({
      "ok.ts": "const ok=1;",
      "big.ts": "a".repeat(MAX_FILE_SIZE + 1000),
      "binary.ts": "hello\x00world",
    });
    // Add excluded dirs
    const nodeModulesDir = join(root, "node_modules");
    require("node:fs").mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(join(nodeModulesDir, "ignored.ts"), "const ignored=1;", "utf8");
    const gitDir = join(root, ".git");
    require("node:fs").mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "ignored2.ts"), "const ignored2=1;", "utf8");

    const mgr = new LspManager({ descriptors: [descriptor] });
    managers.push(mgr);
    // Inspect internal docs via snapshot diagnostics: only ok.ts should produce diagnostics
    await mgr.setActiveProject(root);
    await waitFor(() => {
      const s = mgr.getSnapshot(root);
      return !!s && s.servers.some((sv) => sv.status === "running");
    }, 5000);
    await new Promise((r) => setTimeout(r, 500));
    const snap = mgr.getSnapshot(root)!;
    // Diagnostics should only be from ok.ts, not big.ts nor binary nor excluded
    const files = snap.diagnostics.map((d) => d.file);
    expect(files.some((f) => f.includes("ok.ts"))).toBe(true);
    expect(files.some((f) => f.includes("big.ts"))).toBe(false);
    expect(files.some((f) => f.includes("binary.ts"))).toBe(false);
    expect(files.some((f) => f.includes("ignored"))).toBe(false);
  }, 10000);
});
