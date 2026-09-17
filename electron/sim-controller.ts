import { randomUUID } from "node:crypto";
import { WebContentsView, shell, type BrowserWindow } from "electron";
import {
  effectiveZoom,
  normalizeZoomFactor,
  resolveViewport,
  sanitizeEmulation,
  sanitizeSimBounds,
  sanitizeSimUrl,
  sanitizeViewport,
  type SimEmulation,
} from "../src/lib/simulator";

export interface SimControllerDeps {
  getWindow: () => BrowserWindow | null;
  /** Forward guest events to the renderer (sim-event stream). */
  notify: (payload: Record<string, unknown>) => void;
}

export interface SimTabInfo {
  id: string;
  url: string;
  title: string | null;
  loading: boolean;
  zoomFactor: number;
}

interface TabState {
  id: string;
  view: WebContentsView;
  emulation: SimEmulation | null;
  /** ⋮-menu page zoom (the label). Multiplied by fitZoom on apply. */
  userZoom: number;
  /** Panel fit factor for emulated viewports (1 in fill mode). */
  fitZoom: number;
  /** Default UA captured before any override, restored in fill mode. */
  originalUA: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  boundsSet: boolean;
  added: boolean;
  lastUrl: string;
  title: string | null;
  loading: boolean;
}

const APPLY_TIMEOUT_MS = 5000;
const SSHOT_MAX_WIDTH = 1440;
const TEXT_CAP = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("sim command timed out")), ms);
  });
  return Promise.race([p.finally(() => { if (timer) clearTimeout(timer); }), timeout]);
}

/**
 * Owns the simulator guests: one WebContentsView per tab, only the active
 * tab bound to the window. Shared by the renderer IPC surface and the agent
 * tools. Per-tab operation chains keep navigate/close/activate races serial.
 */
export class SimController {
  private tabs = new Map<string, TabState>();
  private order: string[] = [];
  private activeId: string | null = null;
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: SimControllerDeps) {}

  /** Serialize async work per key so tab races (navigate vs close vs switch) settle in order. Entries are dropped when the tab closes. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const current = prev.catch(() => undefined).then(fn);
    this.chains.set(key, current.then(
      () => undefined,
      () => undefined,
    ));
    return current;
  }

  listTabs(): { tabs: SimTabInfo[]; activeId: string | null } {
    return {
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((t): t is TabState => !!t && !t.view.webContents.isDestroyed())
        .map((t) => ({ id: t.id, url: t.lastUrl, title: t.title, loading: t.loading, zoomFactor: t.userZoom })),
      activeId: this.activeId && this.tabs.has(this.activeId) ? this.activeId : null,
    };
  }

  private emitTabs(): void {
    this.deps.notify({ type: "tabs", ...this.listTabs() });
  }

  private live(id?: string | null): TabState {
    const tabId = id ?? this.activeId;
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error("sim tab is not open");
    return tab;
  }

  /** Create a tab (idempotent per id) and activate it.
   * No URL means a blank tab: the guest stays unbound until navigated,
   * so the renderer can show its new-tab page in the slot instead. */
  openTab(opts: { url?: string; tabId?: string; activate?: boolean }): Promise<SimTabInfo> {
    const url = opts.url === undefined ? "" : (sanitizeSimUrl(opts.url) ?? "");
    if (opts.url !== undefined && !url) throw new Error("sim only loads http(s) URLs");
    if (!this.deps.getWindow()) throw new Error("sim needs an open window");
    const id = opts.tabId ?? `tab-${randomUUID().slice(0, 8)}`;
    return this.serial(id, async () => {
      const existing = this.tabs.get(id);
      if (existing && !existing.view.webContents.isDestroyed()) {
        if (url) await existing.view.webContents.loadURL(url);
        if (opts.activate !== false) this.activateUnlocked(id);
        else this.emitTabs();
        return this.info(existing);
      }
      const view = new WebContentsView({
        webPreferences: {
          partition: "persist:simulator",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      // Dark undercoat: the default white paints as a flash on every
      // navigation before first content paint. Matches the app window.
      try {
        view.setBackgroundColor("#161616");
      } catch {
        /* older builds ignore it */
      }
      const tab: TabState = {
        id,
        view,
        emulation: null,
        userZoom: 1,
        fitZoom: 1,
        originalUA: null,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        boundsSet: false,
        added: false,
        lastUrl: url,
        title: null,
        loading: true,
      };
      this.wireTab(tab);
      this.tabs.set(id, tab);
      this.order.push(id);
      try {
        tab.originalUA = view.webContents.getUserAgent();
      } catch {
        tab.originalUA = null;
      }
      this.applyZoom(tab);
      if (url) await view.webContents.loadURL(url);
      else tab.loading = false;
      if (opts.activate !== false) this.activateUnlocked(id);
      else this.emitTabs();
      this.deps.notify({ type: "visibility", open: true });
      return this.info(tab);
    });
  }

  private info(tab: TabState): SimTabInfo {
    return { id: tab.id, url: tab.lastUrl, title: tab.title, loading: tab.loading, zoomFactor: tab.userZoom };
  }

  /** Apply user zoom × fit factor. CDP metrics only change the LAYOUT
   * viewport, so without this an emulated viewport clips to the window. */
  private applyZoom(tab: TabState): void {
    try {
      tab.view.webContents.setZoomFactor(effectiveZoom(tab.userZoom, tab.fitZoom));
    } catch {
      /* applies on next navigation */
    }
  }

  private wireTab(tab: TabState): void {
    const wc = tab.view.webContents;
    const id = tab.id;
    wc.setWindowOpenHandler(({ url: popup }) => {
      if (sanitizeSimUrl(popup)) void shell.openExternal(popup);
      return { action: "deny" };
    });
    try {
      wc.session.setPermissionRequestHandler((_w, _permission, callback) => callback(false));
    } catch {
      /* sessions without a handler setter */
    }
    wc.on("page-title-updated", (_ev, title) => {
      const t = this.tabs.get(id);
      if (t) t.title = title;
      this.deps.notify({ type: "title", tabId: id, title });
    });
    wc.on("did-start-loading", () => {
      const t = this.tabs.get(id);
      if (t) t.loading = true;
      this.deps.notify({ type: "loading", tabId: id, loading: true });
      this.emitTabs();
    });
    wc.on("did-stop-loading", () => {
      const t = this.tabs.get(id);
      if (t) t.loading = false;
      this.deps.notify({ type: "loading", tabId: id, loading: false, ...this.navState(id) });
      this.emitTabs();
    });
    wc.on("did-navigate", (_ev, navUrl) => {
      const t = this.tabs.get(id);
      if (t) t.lastUrl = navUrl;
      this.deps.notify({ type: "url", tabId: id, url: navUrl, ...this.navState(id) });
      this.emitTabs();
    });
    wc.on("did-navigate-in-page", (_ev, navUrl) => {
      const t = this.tabs.get(id);
      if (t) t.lastUrl = navUrl;
      this.deps.notify({ type: "url", tabId: id, url: navUrl, ...this.navState(id) });
    });
    wc.on("did-finish-load", () => {
      void this.applyEmulation(id);
    });
    wc.on("did-fail-load", (_ev, code, desc, validatedURL, isMainFrame) => {
      if (isMainFrame && code !== -3) this.deps.notify({ type: "fail", tabId: id, error: desc, url: validatedURL });
    });
    wc.on("render-process-gone", (_ev, details) =>
      this.deps.notify({ type: "crashed", tabId: id, reason: details?.reason ?? "gone" })
    );
  }

  /** Bind the tab's view to the window; hidden tabs stay alive but detached. */
  private activateUnlocked(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const win = this.deps.getWindow();
    if (!win) return;
    for (const [otherId, other] of this.tabs) {
      if (otherId !== id && other.added) {
        try {
          win.contentView.removeChildView(other.view);
        } catch {
          /* already removed */
        }
        other.added = false;
      }
    }
    // Never paint at a stale rect: only bind once the slot reported bounds.
    if (tab.boundsSet && !tab.added) {
      try {
        win.contentView.addChildView(tab.view);
        tab.added = true;
        tab.view.setBounds(tab.bounds);
      } catch {
        /* window gone */
      }
    }
    this.activeId = id;
    this.emitTabs();
    void this.applyEmulation(id);
  }

  activate(id: string): Promise<SimTabInfo> {
    return this.serial(id, async () => {
      const tab = this.live(id);
      this.activateUnlocked(tab.id);
      return this.info(tab);
    });
  }

  closeTab(id?: string | null): Promise<{ closed: boolean }> {
    const tabId = id ?? this.activeId;
    if (!tabId) return Promise.resolve({ closed: false });
    return this.serial(tabId, async () => {
      const tab = this.tabs.get(tabId);
      if (!tab) return { closed: false };
      try {
        this.deps.getWindow()?.contentView.removeChildView(tab.view);
      } catch {
        /* already removed */
      }
      try {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      } catch {
        /* already gone */
      }
      this.tabs.delete(tabId);
      this.order = this.order.filter((t) => t !== tabId);
      this.chains.delete(tabId);
      if (this.activeId === tabId) {
        const next = this.order[this.order.length - 1] ?? null;
        this.activeId = null;
        if (next) this.activateUnlocked(next);
        else this.emitTabs();
      } else {
        this.emitTabs();
      }
      return { closed: true };
    });
  }

  /** Detach all views from the window, keeping tabs alive for re-attach. */
  detachAll(): void {
    const win = this.deps.getWindow();
    for (const [, tab] of this.tabs) {
      if (!tab.added) continue;
      try {
        win?.contentView.removeChildView(tab.view);
      } catch {
        /* already removed */
      }
      tab.added = false;
    }
  }

  closeAll(): void {
    for (const [, tab] of this.tabs) {
      try {
        this.deps.getWindow()?.contentView.removeChildView(tab.view);
      } catch {
        /* already removed */
      }
      try {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      } catch {
        /* already gone */
      }
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
    this.chains.clear();
    this.deps.notify({ type: "visibility", open: false });
  }

  /** Renderer adopt: bind the active tab to the visible slot. */
  async attach(): Promise<{ tabs: SimTabInfo[]; activeId: string | null; emulation: SimEmulation | null }> {
    const snap = this.listTabs();
    if (snap.activeId) {
      const tab = this.tabs.get(snap.activeId);
      if (tab) {
        this.activateUnlocked(tab.id);
        return { ...snap, emulation: tab.emulation };
      }
    }
    return { ...snap, emulation: null };
  }

  setBounds(tabId: string | undefined, raw: unknown): void {
    const rect = sanitizeSimBounds(raw);
    if (!rect) return;
    const tab = tabId ? this.tabs.get(tabId) : this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.bounds = rect;
    tab.boundsSet = true;
    // Only the active tab paints; the slot reports for the visible one.
    if (tab.id !== this.activeId) return;
    const win = this.deps.getWindow();
    if (!win) return;
    if (!tab.added) {
      try {
        win.contentView.addChildView(tab.view);
        tab.added = true;
      } catch {
        return;
      }
    }
    try {
      tab.view.setBounds(rect);
    } catch {
      /* view gone */
    }
  }

  async setEmulation(tabId: string | undefined, raw: unknown, source: "renderer" | "agent" = "renderer"): Promise<{ ok: true }> {
    const emulation = sanitizeEmulation(raw);
    if (!emulation) throw new Error("invalid emulation");
    const tab = this.live(tabId);
    tab.emulation = emulation;
    await this.applyEmulation(tab.id);
    if (source === "agent") this.deps.notify({ type: "emulation", tabId: tab.id, emulation });
    return { ok: true as const };
  }

  /** Renderer viewport switch: fill clears all overrides, otherwise resolve + apply. */
  async setViewport(tabId: string | undefined, raw: unknown): Promise<{ ok: true }> {
    const viewport = sanitizeViewport(raw);
    if (!viewport) throw new Error("invalid viewport");
    const tab = this.live(tabId);
    tab.emulation = resolveViewport(viewport);
    await this.applyEmulation(tab.id);
    return { ok: true as const };
  }

  async setZoomFactor(tabId: string | null | undefined, raw: unknown): Promise<{ zoomFactor: number }> {
    const tab = this.live(tabId);
    const zoomFactor = normalizeZoomFactor(raw);
    tab.userZoom = zoomFactor;
    this.applyZoom(tab);
    this.emitTabs();
    return { zoomFactor };
  }

  /** Panel fit factor for the active emulation (1 = fill). No tabs event:
   * the ⋮ label shows user zoom only. */
  setFitZoom(tabId: string | null | undefined, raw: unknown): void {
    const tabIdResolved = tabId ?? this.activeId;
    const tab = tabIdResolved ? this.tabs.get(tabIdResolved) : undefined;
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const f = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
    if (!f || f <= 0) return;
    tab.fitZoom = Math.min(1, f);
    this.applyZoom(tab);
  }

  async hardReload(tabId?: string | null): Promise<{ ok: true }> {
    await this.live(tabId).view.webContents.reloadIgnoringCache();
    return { ok: true as const };
  }

  openDevTools(tabId?: string | null): void {
    try {
      this.live(tabId).view.webContents.openDevTools({ mode: "detach" });
    } catch {
      /* no guest */
    }
  }

  async clearCookies(tabId?: string | null): Promise<{ ok: true }> {
    await this.live(tabId).view.webContents.session.clearStorageData({ storages: ["cookies"] });
    return { ok: true as const };
  }

  async clearCache(tabId?: string | null): Promise<{ ok: true }> {
    await this.live(tabId).view.webContents.session.clearCache();
    return { ok: true as const };
  }

  async ensureOpen(url?: string): Promise<TabState> {
    if (this.activeId) {
      const tab = this.tabs.get(this.activeId);
      if (tab && !tab.view.webContents.isDestroyed()) return tab;
    }
    const target = url ?? this.order.map((id) => this.tabs.get(id)?.lastUrl).find(Boolean) ?? null;
    const clean = target ? sanitizeSimUrl(target) : null;
    if (!clean) throw new Error("no page open — browser_open a URL first");
    await this.openTab({ url: clean });
    return this.live();
  }

  async navigate(tabId: string | undefined, rawUrl: string): Promise<{ ok: true }> {
    const url = sanitizeSimUrl(rawUrl);
    if (!url) throw new Error("sim only loads http(s) URLs");
    if (tabId) {
      await this.live(tabId).view.webContents.loadURL(url);
      return { ok: true as const };
    }
    const tab = await this.ensureOpen(url);
    await tab.view.webContents.loadURL(url);
    return { ok: true as const };
  }

  reload(tabId?: string | null): void {
    this.live(tabId).view.webContents.reload();
  }

  back(tabId?: string | null): void {
    const wc = this.live(tabId).view.webContents;
    try {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    } catch {
      /* no history */
    }
  }

  forward(tabId?: string | null): void {
    const wc = this.live(tabId).view.webContents;
    try {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    } catch {
      /* no history */
    }
  }

  private navState(id: string): { canBack: boolean; canForward: boolean } {
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return { canBack: false, canForward: false };
    try {
      return { canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() };
    } catch {
      return { canBack: false, canForward: false };
    }
  }

  private async withDebugger<T>(tab: TabState, fn: (send: (method: string, params?: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
    const wc = tab.view.webContents;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach();
    } catch (e) {
      throw new Error(`sim debugger unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return fn((method, params) => withTimeout(wc.debugger.sendCommand(method, params), APPLY_TIMEOUT_MS));
  }

  /** Attach CDP and apply the stored emulation (viewport, DPR, UA, touch).
   * Null emulation (fill mode) clears every override instead. */
  async applyEmulation(id?: string): Promise<void> {
    const tab = id ? this.tabs.get(id) : this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!tab) return;
    if (tab.view.webContents.isDestroyed()) return;
    if (!tab.emulation) {
      try {
        await this.withDebugger(tab, async (send) => {
          await send("Emulation.clearDeviceMetricsOverride", {});
          if (tab.originalUA) await send("Emulation.setUserAgentOverride", { userAgent: tab.originalUA });
          await send("Emulation.setTouchEmulationEnabled", { enabled: false });
        });
      } catch {
        // Transient (navigation race, DevTools open): re-applied on next load.
      }
      return;
    }
    const e = tab.emulation;
    try {
      await this.withDebugger(tab, async (send) => {
        await send("Emulation.setDeviceMetricsOverride", {
          width: e.viewportW,
          height: e.viewportH,
          deviceScaleFactor: e.dpr,
          mobile: e.mobile,
          screenOrientation:
            e.orientation === "landscape"
              ? { angle: 90, type: "landscapePrimary" }
              : { angle: 0, type: "portraitPrimary" },
        });
        await send("Emulation.setUserAgentOverride", { userAgent: e.ua });
        await send("Emulation.setTouchEmulationEnabled", {
          enabled: e.touch,
          configuration: e.touch ? "mobile" : "desktop",
        });
      });
    } catch {
      // Transient (navigation race, DevTools open): re-applied on next load.
    }
  }

  /** Viewport screenshot, capped in width to keep token cost sane. */
  async screenshot(tabId?: string | null): Promise<{ png: Buffer; width: number; height: number }> {
    const wc = this.live(tabId).view.webContents;
    const image = await wc.capturePage();
    const size = image.getSize();
    const scaled = size.width > SSHOT_MAX_WIDTH ? image.resize({ width: SSHOT_MAX_WIDTH, height: Math.round((SSHOT_MAX_WIDTH / size.width) * size.height) }) : image;
    const out = scaled.getSize();
    return { png: scaled.toPNG(), width: out.width, height: out.height };
  }

  /** Rendered text snapshot of the page. */
  async snapshot(tabId?: string | null): Promise<{ url: string; title: string; text: string }> {
    const tab = this.live(tabId);
    const wc = tab.view.webContents;
    const run = async (code: string): Promise<any> => {
      try {
        return await wc.executeJavaScript(code, true);
      } catch (e) {
        throw new Error(`page read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const url = String((await run("location.href")) ?? "");
    const title = String((await run("document.title")) ?? "");
    const text = String((await run("(document.body ? document.body.innerText : '').slice(0, 12000)")) ?? "").slice(0, TEXT_CAP);
    return { url, title, text };
  }

  private checkSelector(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 500) throw new Error("selector must be a non-empty CSS selector (≤500 chars)");
    return raw.trim();
  }

  /** Locate an element's center in page CSS px. */
  private async locate(tab: TabState, selector: string): Promise<{ x: number; y: number; text: string }> {
    const wc = tab.view.webContents;
    const probe = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return { hidden: true }; return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText ?? el.value ?? '').slice(0, 200) }; })()`;
    let found: any;
    try {
      found = await wc.executeJavaScript(probe, true);
    } catch (e) {
      throw new Error(`page query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!found) throw new Error(`no element matches ${selector}`);
    if (found.hidden) throw new Error(`element ${selector} is not visible`);
    return { x: Math.round(found.x), y: Math.round(found.y), text: String(found.text ?? "") };
  }

  async click(tabId: string | undefined, rawSelector: string): Promise<{ x: number; y: number; text: string }> {
    const selector = this.checkSelector(rawSelector);
    const tab = this.live(tabId);
    const at = await this.locate(tab, selector);
    const touch = tab.emulation?.touch === true;
    await this.withDebugger(tab, async (send) => {
      if (touch) {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
      }
    });
    return at;
  }

  async fill(tabId: string | undefined, rawSelector: string, rawText: string): Promise<{ value: string }> {
    const selector = this.checkSelector(rawSelector);
    if (typeof rawText !== "string" || rawText.length > 4000) throw new Error("text must be a string (≤4000 chars)");
    const tab = this.live(tabId);
    const wc = tab.view.webContents;
    const prep = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !(el instanceof HTMLElement && el.isContentEditable)) return 'uneditable'; el.focus(); if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select(); else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); } } return 'ok'; })()`;
    let state: any;
    try {
      state = await wc.executeJavaScript(prep, true);
    } catch (e) {
      throw new Error(`page query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (state === "missing") throw new Error(`no element matches ${selector}`);
    if (state !== "ok") throw new Error(`element ${selector} is not a text field`);
    await this.withDebugger(tab, async (send) => {
      await send("Input.insertText", { text: rawText });
    });
    let value = "";
    try {
      value = String(await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return (el.value ?? el.innerText ?? '').slice(0, 500); })()`, true) ?? "");
    } catch {
      /* best effort readback */
    }
    return { value };
  }

  async evaluate(tabId: string | undefined, rawJs: string): Promise<{ result: string }> {
    if (typeof rawJs !== "string" || !rawJs.trim() || rawJs.length > 4000) {
      throw new Error("expression must be a non-empty string (≤4000 chars)");
    }
    const wc = this.live(tabId).view.webContents;
    let out: any;
    try {
      out = await wc.executeJavaScript(rawJs, true);
    } catch (e) {
      throw new Error(`evaluate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let json: string;
    try {
      json = JSON.stringify(out) ?? "undefined";
    } catch {
      json = String(out);
    }
    return { result: json.slice(0, TEXT_CAP) };
  }
}
