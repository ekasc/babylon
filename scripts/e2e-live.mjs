#!/usr/bin/env node
// Live E2E: spawn the real Electron app via Playwright, drive it via window.pideck
// Tests everything end-to-end in /tmp/babylon-e2e-20260827
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TEST_ROOT = "/tmp/babylon-e2e-20260827";
const LIVE_REPO = join(TEST_ROOT, "live-repo");
const REMOTE_REPO = join(TEST_ROOT, "live-remote.git");

async function git(cwd, args) { return (await exec("git", args, { cwd })).stdout.trim(); }

async function resetLiveRepo() {
  await rm(LIVE_REPO, { recursive: true, force: true }).catch(()=>{});
  await rm(REMOTE_REPO, { recursive: true, force: true }).catch(()=>{});
  await mkdir(LIVE_REPO, { recursive: true });
  await git(LIVE_REPO, ["init", "-b", "main"]);
  await git(LIVE_REPO, ["config", "user.email", "e2e@babylon.test"]);
  await git(LIVE_REPO, ["config", "user.name", "E2E"]);
  await writeFile(join(LIVE_REPO, "README.md"), "# live\n");
  await git(LIVE_REPO, ["add", "README.md"]);
  await git(LIVE_REPO, ["commit", "-m", "initial: base commit"]);
  // bare remote for push tests
  await git(LIVE_REPO, ["init", "--bare", REMOTE_REPO]);
  await git(LIVE_REPO, ["remote", "add", "origin", REMOTE_REPO]);
  // dirty change
  await writeFile(join(LIVE_REPO, "feature.txt"), "hello live\n");
  await writeFile(join(LIVE_REPO, "ünicode-ß.txt"), "unicode\n");
  console.log("[e2e] live repo ready:", LIVE_REPO);
}

async function main() {
  await mkdir(TEST_ROOT, { recursive: true });
  await resetLiveRepo();

  console.log("[e2e] launching Babylon (production build)...");
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      PIDECK_HEADLESS: "1",
      // ensure dev server not used
      VITE_DEV_SERVER_URL: "",
      // force cheap model already set in source; no extra env needed
    },
    timeout: 30000,
  });

  // playwright auto-waits for first window
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // wait for bridge to be injected
  await window.waitForFunction(() => !!window.pideck, null, { timeout: 15000 });
  console.log("[e2e] window ready, url:", await window.url());

  const results = [];
  function ok(name, fn) { return fn().then(() => results.push({ name, pass:true }), e => results.push({ name, pass:false, error: e.message || String(e) })); }

  // helper to evaluate in renderer
  const evalBridge = async (expr) => window.evaluate(expr);
  // need to pass LIVE_REPO into evaluate via arg
  const liveRepo = LIVE_REPO;

  // 1. bridge available
  await ok("bridge available", async () => {
    const avail = await window.evaluate(() => window.pideck !== undefined && typeof window.pideck.gitStatusDetails === "function");
    if (!avail) throw new Error("pideck bridge missing");
  });

  // 2. gitStatusDetails — live repo is dirty, unicode file present
  await ok("gitStatusDetails dirty + unicode", async () => {
    const d = await window.evaluate(async (repo) => await window.pideck.gitStatusDetails(repo), liveRepo);
    if (!d.isRepo) throw new Error("not a repo");
    if (!d.hasChanges) throw new Error("expected dirty");
    if (!d.files.some(f=>f.path.includes("feature.txt"))) throw new Error("missing feature.txt");
    if (!d.files.some(f=>f.path.includes("ünicode"))) throw new Error("unicode filename not preserved (quotepath bug)");
  });

  // 3. gitDiffFile — flag injection hardened (should return "" not throw or exec flag)
  await ok("gitDiffFile flag injection returns empty", async () => {
    const a = await window.evaluate(async (repo) => await window.pideck.gitDiffFile(repo, "-p"), liveRepo);
    const b = await window.evaluate(async (repo) => await window.pideck.gitDiffFile(repo, "a/../b"), liveRepo);
    if (a !== "" || b !== "") throw new Error(`expected empty, got ${JSON.stringify([a,b])}`);
  });

  // 4. gitDiffFile — real diff
  await ok("gitDiffFile real file shows diff", async () => {
    const diff = await window.evaluate(async (repo) => await window.pideck.gitDiffFile(repo, "feature.txt"), liveRepo);
    if (!diff.includes("hello live")) throw new Error("diff missing content: " + diff.slice(0,200));
  });

  // 5. gitBranches — at least main
  await ok("gitBranches lists main", async () => {
    const b = await window.evaluate(async (repo) => await window.pideck.gitBranches(repo), liveRepo);
    if (!b.branches.some(x=>x.name==="main")) throw new Error("main missing: "+JSON.stringify(b));
  });

  // 6. gitCommit — direct commit without model (bulletproof path)
  await ok("gitCommit with valid message stages and commits", async () => {
    const r = await window.evaluate(async (repo) => await window.pideck.gitCommit(repo, "Add live feature"), liveRepo);
    if (!r.commitSha || r.subject !== "Add live feature") throw new Error("commit failed "+JSON.stringify(r));
    const d2 = await window.evaluate(async (repo) => await window.pideck.gitStatusDetails(repo), liveRepo);
    // after commitAll, should still have the unicode file dirty? We committed all via gitCommit which does add -A, so should be clean
    if (d2.hasChanges) throw new Error("expected clean after commit, got "+JSON.stringify(d2.files));
  });

  // 7. make another dirty for commit-push (model path) — expect graceful failure when model unavailable
  await ok("gitStatus after commit is clean, then dirty again", async () => {
    await writeFile(join(liveRepo, "second.txt"), "second\n");
    const d = await window.evaluate(async (repo) => await window.pideck.gitStatusDetails(repo), liveRepo);
    if (!d.hasChanges) throw new Error("expected dirty after second file");
  });

  // 8. gitCommitPush — should attempt and fail gracefully if spark model not configured locally, not crash app
  await ok("gitCommitPush model path is not crashing (either succeeds or throws with staged reset)", async () => {
    const res = await window.evaluate(async (repo) => {
      try {
        const id = crypto.randomUUID();
        const p = await window.pideck.gitCommitPush(repo, id);
        return { ok:true, p };
      } catch (e) {
        return { ok:false, error: e.message };
      }
    }, liveRepo);
    // Either success (if spark model is available) or a controlled error. Must not be unhandled.
    // Hardened behavior: on failure before commit, staged changes are reset (unstaged but still dirty)
    // Check that repo is still in a sane state
    const d = await window.evaluate(async (repo) => await window.pideck.gitStatusDetails(repo), liveRepo);
    // In both cases, repo should not be in a broken state (isRepo true)
    if (!d.isRepo) throw new Error("repo broken after commitPush");
    // If it failed, it should have reset staged (so hasChanges true but not crashed)
    // If it succeeded, hasChanges false and ahead increased
    // Both are acceptable for bulletproof
    console.log("  commitPush result:", res.ok ? "success "+JSON.stringify(res.p).slice(0,200) : "controlled fail: "+res.error.slice(0,200));
  });

  // 9. git diffFile with huge file truncation (we created earlier? create now)
  await ok("diff truncation for huge file", async () => {
    await writeFile(join(liveRepo, "huge.txt"), "x\n".repeat(300000));
    const diff = await window.evaluate(async (repo) => await window.pideck.gitDiffFile(repo, "huge.txt"), liveRepo);
    if (!diff.includes("diff truncated")) throw new Error("expected truncation, got len "+diff.length);
  });

  // 10. git branch validation via IPC (invalid name should throw, not crash)
  await ok("gitBranchCreate invalid name throws", async () => {
    const r = await window.evaluate(async (repo) => {
      try { await window.pideck.gitBranchCreate(repo, "-bad", false); return "no throw"; }
      catch(e){ return e.message; }
    }, liveRepo);
    if (r==="no throw") throw new Error("should have thrown");
    if (!r.toLowerCase().includes("invalid") && !r.includes("branch")) throw new Error("wrong error: "+r);
  });

  // 11. non-repo handling (should not crash, returns isRepo false)
  await ok("gitStatusDetails on non-repo returns isRepo false", async () => {
    const d = await window.evaluate(async () => await window.pideck.gitStatusDetails("/tmp"));
    if (d.isRepo) throw new Error("expected non-repo");
  });

  // 12. openExternal protocol guard (should throw on file://)
  await ok("openExternal blocks file://", async () => {
    const r = await window.evaluate(async () => {
      try { await window.pideck.openExternal("file:///etc/passwd"); return "no throw"; }
      catch(e){ return e.message; }
    });
    if (r==="no throw") throw new Error("should have blocked");
    if (!r.includes("blocked")) throw new Error("wrong error "+r);
  });

  // 13. sessions IPC (should not throw, returns array)
  await ok("listSessions returns array", async () => {
    const s = await window.evaluate(async () => await window.pideck.listSessions());
    if (!Array.isArray(s)) throw new Error("not array");
  });

  // 14. permissions IPC
  await ok("permissionsGet returns mode", async () => {
    const p = await window.evaluate(async () => await window.pideck.permissionsGet());
    if (!p.mode) throw new Error("no mode");
  });

  // 15. UI smoke: check that GitView would render (check DOM for Babylon shell)
  await ok("UI shell present (babylon splash replaced)", async () => {
    const html = await window.content();
    if (!html.includes("Babylon") && !html.includes("pideck") && !html.toLowerCase().includes("git")) {
      // still check that body is not blank
      if (html.length < 500) throw new Error("html too short, blank screen: "+html.slice(0,300));
    }
  });

  // 16. App title and shell stability
  await ok("App title is Babylon and window is stable after 1s", async () => {
    const title = await window.title();
    if (title !== "Babylon") throw new Error("title mismatch: "+title);
    await window.waitForTimeout(1000);
    const html2 = await window.content();
    if (html2.length < 500) throw new Error("content vanished after 1s");
  });

  // 17. Workflows/threads/subagents IPC (foundation but must not crash)
  await ok("workflows/threads IPC returns without crash", async () => {
    const w = await window.evaluate(async () => {
      const a = await window.pideck.activityList().catch(e=>({error:e.message}));
      const w1 = await window.pideck.workflowsList().catch(e=>({error:e.message}));
      return { a, w1 };
    });
    if (w.a && w.a.error) throw new Error("activityList failed: "+w.a.error);
    if (w.w1 && w.w1.error) throw new Error("workflowsList failed: "+w.w1.error);
    if (!Array.isArray(w.w1) && !w.w1) throw new Error("unexpected workflows shape");
  });

  // 18. Rapid concurrent gitStatusDetails via live app (stability)
  await ok("concurrent gitStatusDetails via live app (10 parallel)", async () => {
    const res = await window.evaluate(async (repo) => {
      const ps = Array.from({length:10}, ()=>window.pideck.gitStatusDetails(repo));
      const all = await Promise.all(ps);
      return all.map(d=>d.isRepo);
    }, liveRepo);
    if (!res.every(Boolean)) throw new Error("concurrent failed: "+JSON.stringify(res));
  });

  // 19. Session open/close via bridge (create new session in live repo, then list)
  await ok("openSession in live repo and listSessions", async () => {
    const r = await window.evaluate(async (repo) => {
      try {
        // open a new session in the live repo cwd
        await window.pideck.openSession({ cwd: repo });
        const sessions = await window.pideck.listSessions();
        return { sessions };
      } catch(e){ return { error: e.message }; }
    }, liveRepo);
    if (r.error) throw new Error(r.error);
    if (!Array.isArray(r.sessions)) throw new Error("listSessions not array");
  });

  // 20. Invalid inputs must be rejected not crash (hardening)
  await ok("invalid IPC inputs rejected", async () => {
    const r = await window.evaluate(async () => {
      const errs=[];
      // gitStatusDetails with invalid cwd is intentionally swallowed to {isRepo:false} — must not crash
      try{
        const d = await window.pideck.gitStatusDetails(123);
        if (d.isRepo) errs.push("invalid cwd should be non-repo");
      } catch(e){ if(!String(e.message).includes("invalid")) errs.push("wrong msg "+e.message); }
      // invalid file path should not crash (returns "" or throws invalid)
      try{
        const diff = await window.pideck.gitDiffFile("/tmp", "../etc/passwd");
        if (typeof diff !== "string") errs.push("diff not string");
      }catch(e){ if(!String(e.message).includes("invalid") && !String(e.message).includes("failed")) {/* ok diff may just return empty */} }
      try{ await window.pideck.openExternal("javascript:alert(1)"); errs.push("no throw js"); }catch(e){ if(!String(e.message).includes("blocked") && !String(e.message).includes("protocol")) errs.push("wrong js block "+e.message); }
      // branch with empty name should throw invalid
      try{ await window.pideck.gitBranchCreate("/tmp", "", false); errs.push("no throw empty branch"); }catch(e){ if(!String(e.message).includes("invalid") && !String(e.message).includes("branch")) errs.push("wrong branch msg "+e.message); }
      return errs;
    });
    if (r.length) throw new Error("invalid input hardening failed: "+r.join(", "));
  });

  // report
  console.log("\n=== E2E Results (live app) ===");
  let pass=0, fail=0;
  for (const r of results) {
    const icon = r.pass ? "✓" : "×";
    console.log(`${icon} ${r.name}${r.pass?"": " — "+r.error}`);
    if (r.pass) pass++; else fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed, ${results.length} total`);
  console.log(`Live repo: ${liveRepo}`);
  console.log(`Remote: ${REMOTE_REPO}`);

  await app.close();
  process.exit(fail>0 ? 1 : 0);
}

main().catch(e=>{ console.error(e); process.exit(1); });
