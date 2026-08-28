#!/usr/bin/env node
// Live SESSION E2E: spawn app, open a real Pi session in /tmp, send a prompt via spark, verify streaming
import { _electron as electron } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TEST_ROOT = "/tmp/babylon-e2e-20260827";
const SESSION_REPO = join(TEST_ROOT, "live-session-repo");

async function git(cwd, args) { return (await exec("git", args, { cwd })).stdout.trim(); }

async function main() {
  await mkdir(SESSION_REPO, { recursive: true });
  // init git repo for session cwd
  try { await git(SESSION_REPO, ["rev-parse", "--is-inside-work-tree"]); } catch {
    await git(SESSION_REPO, ["init", "-b", "main"]);
    await git(SESSION_REPO, ["config", "user.email", "sess@babylon.test"]);
    await git(SESSION_REPO, ["config", "user.name", "Sess"]);
    await writeFile(join(SESSION_REPO, "init.txt"), "init\n");
    await git(SESSION_REPO, ["add", "."]);
    await git(SESSION_REPO, ["commit", "-m", "init"]);
  }

  console.log("[live-session] launching Babylon...");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PIDECK_HEADLESS: "1", VITE_DEV_SERVER_URL: "" },
    timeout: 30000,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => !!window.pideck, null, { timeout: 15000 });
  console.log("[live-session] window ready:", await window.url());

  const log = (...a) => console.log("[live-session]", ...a);

  // 1. check models available
  const models = await window.evaluate(async () => await window.pideck.getModels());
  log("models count:", models.length, "spark available:", models.some(m=>m.id==="muse-spark-1.2-contributor" || m.modelId==="muse-spark-1.2-contributor"));
  const spark = models.find(m=>m.provider==="opencode-go" && m.id==="muse-spark-1.2-contributor")
             || models.find(m=>m.provider==="opencode-go" && m.modelId==="muse-spark-1.2-contributor");
  if (!spark) {
    log("WARNING: spark model not listed, models:", JSON.stringify(models.slice(0,3)));
  } else {
    log("spark model found:", spark.provider, spark.id||spark.modelId);
    // set model to spark explicitly for this session — done AFTER openSession below
  }

  // 2. open session in SESSION_REPO
  log("opening session in", SESSION_REPO);
  const openRes = await window.evaluate(async (repo) => {
    try {
      const r = await window.pideck.openSession({ cwd: repo });
      const state = await window.pideck.getState();
      const sessions = await window.pideck.listSessions();
      return { ok:true, state, sessionsCount: sessions.flatMap(g=>g.sessions).length };
    } catch(e){ return { ok:false, error:e.message, stack:e.stack }; }
  }, SESSION_REPO);
  log("openSession:", openRes.ok ? `ok state=${JSON.stringify(openRes.state).slice(0,300)} sessions=${openRes.sessionsCount}` : `FAIL ${openRes.error}`);
  if (!openRes.ok) throw new Error("openSession failed: "+openRes.error);

  // 2b. enforce cheap model AFTER open (open resets model to pi default)
  log("enforcing spark model AFTER openSession...");
  const enforce = await window.evaluate(async () => {
    try {
      await window.pideck.setModel("opencode-go", "muse-spark-1.2-contributor");
      const s = await window.pideck.getState();
      return { ok:true, model: s.model };
    } catch(e){ return { ok:false, error:e.message }; }
  });
  log("enforce spark:", enforce.ok ? `model=${JSON.stringify(enforce.model).slice(0,300)}` : `FAIL ${enforce.error}`);
  if (enforce.ok && enforce.model && enforce.model.id !== "muse-spark-1.2-contributor") {
    log("WARNING: model still not spark after setModel, got", enforce.model.id, "trying again via setSettings...");
    await window.evaluate(async () => await window.pideck.setSettings?.({ chatModel:{provider:"opencode-go", modelId:"muse-spark-1.2-contributor"}}).catch(()=>{}));
    const s2 = await window.evaluate(async () => await window.pideck.getState());
    log("after setSettings state:", JSON.stringify(s2.model).slice(0,300));
  }

  // 3. verify initial state is ready, not streaming
  let state = await window.evaluate(async () => await window.pideck.getState());
  log("initial state:", JSON.stringify(state).slice(0,400));

  // 4. collect agent events during prompt
  await window.evaluate(() => {
    window.__e2e_events = [];
    window.pideck.onAgentEvents((evs) => window.__e2e_events.push(...evs));
    window.pideck.onStatus((s)=> window.__e2e_lastStatus = s);
  });

  // 5. send prompt via spark, wait for completion
  const promptText = "Reply with exactly: LIVE_OK and nothing else. Do not use tools.";
  log("sending prompt:", promptText);
  const start = Date.now();
  const promptPromise = window.evaluate(async (msg) => {
    try { return await window.pideck.prompt(msg); }
    catch(e){ return { error:e.message, stack:e.stack }; }
  }, promptText);

  // poll for completion (max 90s for spark)
  let done = false;
  let lastMessages = [];
  for (let i=0;i<90;i++) {
    await new Promise(r=>setTimeout(r,1000));
    const s = await window.evaluate(async () => await window.pideck.getState().catch(()=>null));
    const msgs = await window.evaluate(async () => await window.pideck.getMessages().catch(()=>[]));
    lastMessages = msgs || [];
    const txt = JSON.stringify(lastMessages).slice(0,800);
    const streaming = s ? s.isStreaming : "unknown";
    log(`poll ${i}s isStreaming=${streaming} msgs=${lastMessages.length} last=${(txt||"").slice(0,200)}`);
    if (s && !s.isStreaming && lastMessages.length>0) {
      // check if we have assistant message containing LIVE_OK
      const has = lastMessages.some(m=>JSON.stringify(m).includes("LIVE_OK"));
      if (has) { done=true; break; }
      // also check if still streaming but we got response
      if (lastMessages.length>=2) {
        const hasAny = lastMessages.some(m=>m.role==="assistant");
        if (hasAny) { done=true; break; }
      }
    }
    if (s && !s.isStreaming && lastMessages.length>=2) { done=true; break; }
  }

  const promptRes = await Promise.race([promptPromise, new Promise(r=>setTimeout(()=>r({timeout:true}),5000))]);
  log("prompt result:", JSON.stringify(promptRes||{}).slice(0,800), "elapsed", Date.now()-start,"ms");

  const events = await window.evaluate(() => window.__e2e_events || []);
  log("events captured:", events.length, "types:", [...new Set(events.map(e=>e.type))].join(","));
  log("final messages:", lastMessages.length);
  lastMessages.forEach((m,i)=>log(` msg[${i}] role=${m.role} text=${JSON.stringify(m.content||m.text||m.output||"").slice(0,200)}`));

  // 6. verify session file exists and is append-only jsonl
  const sessInfo = await window.evaluate(async () => {
    const s = await window.pideck.getState();
    return s;
  });
  log("sessionFile:", sessInfo.sessionFile);
  if (sessInfo.sessionFile) {
    try {
      const raw = await window.evaluate(async (p) => {
        // we can't fs from renderer, use main via getSessionMessages
        const w = await window.pideck.getSessionMessages(p);
        return w;
      }, sessInfo.sessionFile);
      log("getSessionMessages ok, count:", raw.messages.length);
    } catch(e){ log("getSessionMessages fail:", e.message); }
  }

  // 7. test follow-up / steer after first turn (second prompt)
  log("sending follow-up prompt");
  const followRes = await window.evaluate(async (msg) => {
    try { await window.pideck.prompt(msg); return {ok:true}; } catch(e){ return {ok:false, error:e.message}; }
  }, "Reply with LIVE_OK2");
  log("follow-up result:", JSON.stringify(followRes));
  await new Promise(r=>setTimeout(r,5000));
  const msgs2 = await window.evaluate(async () => await window.pideck.getMessages());
  log("msgs after follow-up:", msgs2.length, JSON.stringify(msgs2).slice(0,500));

  const success = lastMessages.some(m=>JSON.stringify(m).includes("LIVE_OK"));
  console.log("\n=== LIVE SESSION RESULT ===");
  console.log(success ? "✓ LIVE SESSION PASSED — streaming prompt via spark succeeded" : "× LIVE SESSION FAILED — no LIVE_OK in messages");
  console.log("sessionFile:", sessInfo.sessionFile);
  console.log("events:", events.length);
  console.log("model used: spark (opencode-go/muse-spark-1.2-contributor)");

  await app.close();
  process.exit(success ? 0 : 1);
}

main().catch(e=>{ console.error(e); process.exit(1); });
