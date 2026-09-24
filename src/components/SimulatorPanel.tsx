import { useCallback, useEffect, useRef, useState } from "react";
import {
  findPreset,
  resolveViewport,
  simFitScale,
  type SimViewport,
} from "../lib/simulator";
import { bridge, type SimEvent } from "../bridge";
import { errorMessage } from "../lib/errors";

/** Viewport stage for one browser tab. Fill paints 1:1 edge-to-edge (T3's
 * default); preset/freeform center a fitted device slot. The sidebar owns
 * the viewport and applies it — this component only tracks its slot rect
 * so main can position the guest, plus crash/fatal cards. */
export function SimulatorPanel({ tabId, viewport }: { tabId: string; viewport: SimViewport }) {
  const [crashed, setCrashed] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState({ w: 1200, h: 800 });
  const stageRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);

  const reportBounds = useCallback(() => {
    if (!readyRef.current) return;
    const el = screenRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    void bridge
      .simBounds(tabId, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
      .catch(() => undefined);
  }, [tabId]);

  // Adopt the tab's guest on mount; the guest outlives this component.
  useEffect(() => {
    readyRef.current = false;
    setReady(false);
    setFatal(null);
    setCrashed(null);
    bridge
      .simAttach()
      .then((st) => {
        if (!st.tabs.some((t) => t.id === tabId)) {
          setFatal("Tab is gone.");
          return;
        }
        readyRef.current = true;
        setReady(true);
        reportBounds();
      })
      .catch((e: unknown) => setFatal(errorMessage(e, "Could not attach to the tab")));
    const off = bridge.onSimEvent((ev: SimEvent) => {
      if (!("tabId" in ev) || ev.tabId !== tabId) return;
      if (ev.type === "crashed") {
        readyRef.current = false;
        setReady(false);
        setCrashed(ev.reason);
      }
    });
    return () => {
      readyRef.current = false;
      off();
    };
  }, [tabId, reportBounds]);

  const emulation = resolveViewport(viewport);
  const preset = viewport.mode === "preset" ? findPreset(viewport.presetId) : null;
  const vw = emulation?.viewportW ?? 0;
  const vh = emulation?.viewportH ?? 0;
  const scale = emulation ? simFitScale(vw, vh, stage.w, stage.h) : 1;
  const dispW = Math.max(50, Math.round(vw * scale));
  const dispH = Math.max(50, Math.round(vh * scale));

  // The guest view is positioned by main over the slot div; re-report
  // whenever the stage moves or resizes underneath it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setStage({ w: Math.max(200, r.width - 48), h: Math.max(200, r.height - 48) });
      reportBounds();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [reportBounds]);

  useEffect(() => {
    reportBounds();
  }, [reportBounds, dispW, dispH, ready, viewport]);

  // Fit compensation: a CDP metrics override only changes the LAYOUT viewport,
  // so the panel tells main how much to shrink the page to fit its slot.
  // Fill reports 1 (no compensation).
  useEffect(() => {
    if (!ready) return;
    bridge.simFitZoom(tabId, scale).catch(() => undefined);
  }, [tabId, scale, ready]);

  useEffect(() => {
    const onResize = () => reportBounds();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reportBounds]);

  const retry = () => {
    setCrashed(null);
    setFatal(null);
    readyRef.current = true;
    setReady(true);
    reportBounds();
    bridge.simReload(tabId).catch(() => undefined);
  };

  const blocking = fatal ?? (crashed ? `Renderer crashed (${crashed})` : null);
  const framed = preset && preset.kind === "mobile" ? preset.chrome : null;

  return (
    <div aria-label="Browser viewport" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
      <div
        ref={stageRef}
        className={
          emulation === null
            ? "min-h-0 flex-1 overflow-hidden bg-[#161616]"
            : "grid min-h-0 flex-1 place-items-center overflow-auto bg-inset/40 p-6"
        }
      >
        {blocking ? (
          <div className="max-w-[420px] rounded-[var(--radius-sm)] border border-err/30 bg-bg px-4 py-3 text-center">
            <p className="text-[13px] font-medium text-err">{blocking}</p>
            {fatal ? null : <button type="button" onClick={retry} className="context-button mt-2">Reload</button>}
          </div>
        ) : emulation === null ? (
          <div ref={screenRef} className="h-full w-full overflow-hidden bg-[#161616]" />
        ) : framed ? (
          <div className={`relative bg-black shadow-lg ${framed === "notch" ? "rounded-[3rem] p-[10px] pt-[34px]" : framed === "hole" ? "rounded-[2rem] p-[10px] pt-[30px]" : "rounded-[1.5rem] p-[18px]"}`}>
            {framed === "notch" ? (
              <span className="absolute left-1/2 top-[10px] h-[18px] w-[90px] -translate-x-1/2 rounded-full bg-[#111]" aria-hidden />
            ) : null}
            {framed === "hole" ? (
              <span className="absolute left-1/2 top-[9px] h-[12px] w-[12px] -translate-x-1/2 rounded-full bg-[#111] ring-2 ring-zinc-800" aria-hidden />
            ) : null}
            <div
              ref={screenRef}
              style={{ width: dispW, height: dispH }}
              className={`overflow-hidden bg-[#161616] ${framed === "notch" ? "rounded-[2rem]" : framed === "hole" ? "rounded-[1.25rem]" : "rounded-[0.5rem]"}`}
            />
          </div>
        ) : (
          <div
            ref={screenRef}
            style={{ width: dispW, height: dispH }}
            className="overflow-hidden rounded-[var(--radius-sm)] border border-line bg-[#161616] shadow-lg"
          />
        )}
      </div>
    </div>
  );
}
