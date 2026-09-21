import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type ProcessSnapshot, type SimTabState } from "../bridge";
import { detectServerFromCommand } from "../preview-model";
import {
  SIM_PRESETS,
  SIM_VIEWPORT_MAX,
  SIM_VIEWPORT_MIN,
  loadSimPrefs,
  matchViewport,
  resolveViewport,
  saveSimPrefs,
  type SimViewport,
} from "../lib/simulator";
import { SimulatorPanel } from "./SimulatorPanel";
import { errorMessage } from "../lib/errors";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreIcon,
  RefreshIcon,
  RotateIcon,
  XIcon,
} from "./icons";

interface ServerRow {
  key: string;
  processId: string;
  port: number;
  url: string;
  framework: string;
  command: string;
  owner: string;
  state: string;
}

const PROBE_TTL_MS = 5000;
const RESPONSIVE_VALUE = "responsive";

/** Effective pixel size of a viewport for the device toolbar inputs. */
function viewportDims(v: SimViewport): { width: number; height: number } {
  const e = resolveViewport(v);
  if (!e) return { width: 0, height: 0 };
  return { width: e.viewportW, height: e.viewportH };
}

export function SimSidebar() {
  const [tabs, setTabs] = useState<SimTabState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const [draft, setDraft] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [procs, setProcs] = useState<ProcessSnapshot[]>([]);
  const [probes, setProbes] = useState<Record<number, { open: boolean; at: number }>>({});
  const [backendError, setBackendError] = useState<string | null>(null);
  // Per-tab viewport; absent means fill (T3's default: page follows the panel).
  const [viewports, setViewports] = useState<Record<string, SimViewport>>({});
  const [devicePrefs, setDevicePrefs] = useState(loadSimPrefs);
  const activeRef = useRef<string | null>(null);
  const focusedRef = useRef(false);
  const omniboxRef = useRef<HTMLInputElement>(null);

  const viewportFor = useCallback(
    (tabId: string | null): SimViewport => (tabId ? viewports[tabId] ?? { mode: "fill" } : { mode: "fill" }),
    [viewports]
  );

  const applyViewport = useCallback((tabId: string, v: SimViewport) => {
    setViewports((prev) => ({ ...prev, [tabId]: v }));
    bridge.simViewport(tabId, v).catch(() => undefined);
  }, []);

  const setDevicePref = useCallback((next: { presetId: string; rotated: boolean; deviceToolbar: boolean }) => {
    setDevicePrefs(next);
    saveSimPrefs(next);
  }, []);

  const attach = useCallback(() => {
    setBackendError(null);
    bridge
      .simAttach()
      .then((st) => {
        setTabs(st.tabs);
        setActiveId(st.activeId);
        activeRef.current = st.activeId;
        const cur = st.tabs.find((t) => t.id === st.activeId);
        // Seed the omnibox from the live tab: attach (not navigation) is what
        // restores state, so the draft must come from here too.
        if (cur && !focusedRef.current) setDraft(cur.url);
        if (st.activeId) {
          const vp = matchViewport(st.emulation);
          setViewports((prev) => (prev[st.activeId as string] ? prev : { ...prev, [st.activeId as string]: vp }));
        }
        if (st.tabs.length > 0 && st.activeId) setShowList(false);
      })
      .catch((e: unknown) => setBackendError(errorMessage(e, "Browser engine unavailable")));
  }, []);

  // Adopt any live tabs, then track the tab mirror + active-tab chrome state.
  // Unmount detaches (tabs survive sidebar toggles); closing a tab destroys it.
  useEffect(() => {
    attach();
    const off = bridge.onSimEvent((ev) => {
      if (ev.type === "tabs") {
        setTabs(ev.tabs);
        const changed = ev.activeId !== activeRef.current;
        setActiveId(ev.activeId);
        activeRef.current = ev.activeId;
        const cur = ev.tabs.find((t) => t.id === ev.activeId);
        // Seed the omnibox on every tab switch, not just on navigation.
        if (changed && cur && !focusedRef.current) setDraft(cur.url);
        if (ev.tabs.length === 0) setShowList(true);
        else if (changed) setShowList(false);
      } else if (ev.type === "url" && ev.tabId === activeRef.current) {
        if (!focusedRef.current) setDraft(ev.url);
        setCanBack(ev.canBack);
        setCanForward(ev.canForward);
        // A blank tab that navigates becomes a real tab: leave the list.
        if (ev.url) setShowList(false);
      } else if (ev.type === "loading" && ev.tabId === activeRef.current) {
        if (typeof ev.canBack === "boolean") setCanBack(ev.canBack);
        if (typeof ev.canForward === "boolean") setCanForward(ev.canForward);
      } else if (ev.type === "emulation") {
        // Agent-driven emulation change: adopt it as this tab's viewport.
        setViewports((prev) => ({ ...prev, [ev.tabId]: matchViewport(ev.emulation) }));
      }
    });
    return () => {
      off();
      void bridge.simDetach().catch(() => undefined);
    };
  }, [attach]);

  useEffect(() => {
    bridge.processList().then(setProcs).catch(() => undefined);
    return bridge.onProcessUpdate(setProcs);
  }, []);

  const servers = useMemo<ServerRow[]>(() => {
    const rows: ServerRow[] = [];
    for (const p of procs) {
      for (const port of p.detectedPorts ?? []) {
        rows.push({
          key: `${p.id}:${port}`,
          processId: p.id,
          port,
          url: `http://localhost:${port}`,
          framework: detectServerFromCommand(p.command ?? "")?.framework ?? "server",
          command: p.command ?? "",
          owner: p.owner ?? "process",
          state: p.state,
        });
      }
    }
    return rows.sort((a, b) => a.port - b.port);
  }, [procs]);

  // Liveness probes: refresh ports whose result is missing or stale.
  useEffect(() => {
    const now = Date.now();
    const stale = [...new Set(servers.map((s) => s.port))].filter((port) => {
      const prev = probes[port];
      return !prev || now - prev.at > PROBE_TTL_MS;
    });
    if (!stale.length) return;
    let cancelled = false;
    void (async () => {
      const next: Record<number, { open: boolean; at: number }> = {};
      await Promise.all(
        stale.map(async (port) => {
          try {
            const r = await bridge.simProbe(port);
            next[port] = { open: r.open, at: Date.now() };
          } catch {
            /* probe failed: leave stale */
          }
        })
      );
      if (!cancelled && Object.keys(next).length) setProbes((p) => ({ ...p, ...next }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // The list doubles as the new-tab page: it shows with no tabs, on demand,
  // or whenever the active tab hasn't navigated anywhere yet.
  const showingList = showList || !activeTab || activeTab.url === "";
  const activeViewport = useMemo<SimViewport>(
    () => (activeId ? viewports[activeId] ?? { mode: "fill" } : { mode: "fill" }),
    [viewports, activeId]
  );

  // Native menu: a DOM popover would paint UNDER the guest view (separate OS
  // surface), so the ⋮ options live in a real Menu.popup via main.
  const openMenu = () => {
    setSubmitError(null);
    bridge
      .simMenu({ tabId: activeRef.current, showDeviceToolbar: devicePrefs.deviceToolbar })
      .then((r) => {
        if (r?.deviceToolbar !== undefined) setDevicePref({ ...devicePrefs, deviceToolbar: r.deviceToolbar });
      })
      .catch((e: unknown) => setSubmitError(errorMessage(e, "Browser menu unavailable — restart the app")));
  };

  const submitUrl = () => {
    const clean = draft.trim();
    if (!clean) {
      const cur = tabs.find((t) => t.id === activeRef.current);
      setDraft(cur?.url ?? "");
      return;
    }
    setSubmitError(null);
    // The omnibox always drives the active tab (blank tabs navigate in place);
    // with no tabs at all it bootstraps the first one.
    const cur = tabs.find((t) => t.id === activeRef.current);
    if (cur) {
      bridge.simNavigate(cur.id, clean).catch((e: unknown) => setSubmitError(errorMessage(e, "Navigation failed")));
    } else {
      bridge.simOpenTab(clean).catch((e: unknown) => setSubmitError(errorMessage(e, "Could not open tab")));
    }
  };

  const deviceValue =
    activeViewport.mode === "preset" && SIM_PRESETS.some((p) => p.id === activeViewport.presetId)
      ? activeViewport.presetId
      : RESPONSIVE_VALUE;

  const pickDevice = (value: string) => {
    if (!activeRef.current) return;
    if (value === RESPONSIVE_VALUE) {
      applyViewport(activeRef.current, { mode: "fill" });
      return;
    }
    const next = { presetId: value, rotated: devicePrefs.rotated, deviceToolbar: devicePrefs.deviceToolbar };
    setDevicePref(next);
    applyViewport(activeRef.current, { mode: "preset", presetId: value, rotated: next.rotated });
  };

  const toggleRotate = () => {
    if (!activeRef.current) return;
    const v = viewportFor(activeRef.current);
    if (v.mode === "preset") {
      const rotated = !v.rotated;
      setDevicePref({ ...devicePrefs, rotated });
      applyViewport(activeRef.current, { mode: "preset", presetId: v.presetId, rotated });
    } else if (v.mode === "freeform") {
      applyViewport(activeRef.current, { mode: "freeform", width: v.height, height: v.width });
    }
  };

  const applyDims = (width: number, height: number) => {
    if (!activeRef.current) return;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < SIM_VIEWPORT_MIN ||
      width > SIM_VIEWPORT_MAX ||
      height < SIM_VIEWPORT_MIN ||
      height > SIM_VIEWPORT_MAX
    ) {
      return;
    }
    applyViewport(activeRef.current, { mode: "freeform", width, height });
  };

  const dims = viewportDims(activeViewport);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={() => activeRef.current && bridge.simBack(activeRef.current).catch(() => undefined)} disabled={!canBack || showingList} title="Back" aria-label="Back" className="thread-action thread-action-text grid shrink-0 place-items-center p-2 disabled:opacity-40"><ArrowLeftIcon size={16} /></button>
        <button type="button" onClick={() => activeRef.current && bridge.simForward(activeRef.current).catch(() => undefined)} disabled={!canForward || showingList} title="Forward" aria-label="Forward" className="thread-action thread-action-text grid shrink-0 place-items-center p-2 disabled:opacity-40"><ArrowRightIcon size={16} /></button>
        <button
          type="button"
          onClick={() => activeRef.current && !showingList && bridge.simReload(activeRef.current).catch(() => undefined)}
          disabled={!activeTab || showingList}
          title="Reload"
          aria-label="Reload"
          className="thread-action thread-action-text grid shrink-0 place-items-center p-2 disabled:opacity-40"
        >
          <RefreshIcon size={16} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitUrl();
          }}
        >
          <input
            ref={omniboxRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setSubmitError(null); }}
            onFocus={() => {
              focusedRef.current = true;
            }}
            onBlur={() => {
              focusedRef.current = false;
            }}
            placeholder={showingList ? "Enter a URL…" : "Search or enter URL"}
            aria-label="Browser URL"
            spellCheck={false}
            className="settings-input w-full text-[12px]"
          />
        </form>
        <button
          type="button"
          onClick={openMenu}
          title="Browser options"
          aria-haspopup="menu"
          className="thread-action grid shrink-0 place-items-center p-2"
        >
          <MoreIcon size={16} />
        </button>
        <button type="button" onClick={() => activeTab && bridge.openExternal(activeTab.url).catch(() => undefined)} disabled={!activeTab} title="Open in your browser" className="thread-action thread-action-text px-1.5 text-[12px] disabled:opacity-40">Open</button>
      </div>
      {submitError ? (
        <div className="shrink-0 truncate px-3 pb-1 text-[11px] text-err" role="alert">
          {submitError}
        </div>
      ) : null}

      {devicePrefs.deviceToolbar && activeTab && !showingList ? (
        <DeviceToolbar
          value={deviceValue}
          dims={dims}
          rotatable={activeViewport.mode !== "fill"}
          onPick={pickDevice}
          onDims={applyDims}
          onRotate={toggleRotate}
          onClose={() => setDevicePref({ ...devicePrefs, deviceToolbar: false })}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {showingList ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {backendError ? (
              <div className="mb-2 rounded-[var(--radius-sm)] border border-err/30 bg-bg px-3 py-2.5">
                <p className="text-[12px] font-medium text-err">Browser engine unavailable</p>
                <p className="mt-0.5 break-words text-[11px] text-dim">{backendError}</p>
                <button type="button" onClick={attach} className="context-button mt-2">Retry</button>
              </div>
            ) : null}
            <p className="pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">Servers</p>
            {servers.length === 0 ? (
              <p className="px-1 py-2 text-[12px] leading-5 text-dim">
                No servers detected. Start one (e.g. pnpm dev) or enter a URL above.
              </p>
            ) : (
              servers.map((s) => {
                const live = probes[s.port]?.open;
                return (
                  <div key={s.key} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1.5 hover:bg-inset/60">
                    <span
                      title={live ? "Reachable" : live === false ? "Not reachable" : "Probing…"}
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-ok" : live === false ? "bg-err" : "bg-dim"}`}
                    />
                    <button
                      type="button"
                      onClick={() => bridge.simOpenTab(s.url).catch(() => undefined)}
                      title={`Open ${s.url} in a new tab`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-[12px]">{s.url}</span>
                      <span className="block truncate text-[11px] text-dim">{s.framework} · {s.command}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => bridge.processKill(s.processId).catch(() => undefined)}
                      title={`Stop ${s.command}`}
                      className="shrink-0 rounded px-1 text-[11px] text-dim hover:text-err"
                    >
                      Stop
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <SimulatorPanel key={activeTab.id} tabId={activeTab.id} viewport={activeViewport} />
        )}
      </div>
    </div>
  );
}

/** Toggleable device strip: Responsive (= fill) or a preset, freeform W×H, rotate. */
function DeviceToolbar({
  value,
  dims,
  rotatable,
  onPick,
  onDims,
  onRotate,
  onClose,
}: {
  value: string;
  dims: { width: number; height: number };
  rotatable: boolean;
  onPick(value: string): void;
  onDims(width: number, height: number): void;
  onRotate(): void;
  onClose(): void;
}) {
  const [w, setW] = useState(String(dims.width || ""));
  const [h, setH] = useState(String(dims.height || ""));
  // Follow external changes (preset pick, agent resize) without fighting typing.
  const syncKey = `${dims.width}x${dims.height}`;
  const [lastSync, setLastSync] = useState(syncKey);
  if (lastSync !== syncKey) {
    setLastSync(syncKey);
    setW(String(dims.width || ""));
    setH(String(dims.height || ""));
  }
  const commit = () => onDims(Number(w), Number(h));
  return (
    <div className="device-toolbar flex shrink-0 items-center gap-2 border-y border-line/60 px-3 py-1" aria-label="Device toolbar">
      <span className="text-[11px] text-dim">Dimensions</span>
      {/* Native select: a custom dropdown would paint UNDER the guest view,
          but the OS popup draws above it. */}
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        aria-label="Device preset"
        className="settings-input max-w-[190px] text-[12px]"
      >
        <option value={RESPONSIVE_VALUE}>Responsive</option>
        {SIM_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <input
        value={w}
        onChange={(e) => setW(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        inputMode="numeric"
        aria-label="Viewport width"
        className="settings-input w-[64px] text-[12px]"
      />
      <span className="text-[11px] text-dim">×</span>
      <input
        value={h}
        onChange={(e) => setH(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        inputMode="numeric"
        aria-label="Viewport height"
        className="settings-input w-[64px] text-[12px]"
      />
      <button
        type="button"
        onClick={onRotate}
        disabled={!rotatable}
        title="Rotate"
        aria-label="Rotate viewport"
        className="thread-action grid place-items-center p-1.5 disabled:opacity-40"
      >
        <RotateIcon size={16} />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Hide device toolbar"
        aria-label="Hide device toolbar"
        className="ml-auto thread-action grid place-items-center p-1.5"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
