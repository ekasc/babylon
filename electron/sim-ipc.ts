import { BrowserWindow, Menu } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { SimController } from "./sim-controller";
import { probePort } from "./port-probe";

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Renderer IPC surface over the shared multi-tab simulator controller. */
export function registerSimIpc(handle: Handle, deps: { getSimController: () => SimController | null }): void {
  const ctl = () => {
    const c = deps.getSimController();
    if (!c) throw new Error("sim is unavailable");
    return c;
  };

  handle("pideck:sim-open-tab", (_e, raw: unknown) => {
    const url = str((raw as any)?.url);
    return ctl().openTab(url ? { url } : {});
  });
  handle("pideck:sim-activate", (_e, raw: unknown) => {
    const tabId = str((raw as any)?.tabId);
    if (!tabId) throw new Error("tabId is required");
    return ctl().activate(tabId);
  });
  handle("pideck:sim-close-tab", (_e, raw: unknown) => ctl().closeTab(str((raw as any)?.tabId) ?? null));
  handle("pideck:sim-tabs", () => ctl().listTabs());
  handle("pideck:sim-attach", () => ctl().attach());
  handle("pideck:sim-detach", () => {
    ctl().detachAll();
  });
  handle("pideck:sim-close", () => {
    ctl().closeAll();
  });
  handle("pideck:sim-bounds", (_e, raw: unknown) =>
    ctl().setBounds(str((raw as any)?.tabId), (raw as any)?.rect)
  );
  handle("pideck:sim-emulate", (_e, raw: unknown) =>
    ctl().setEmulation(str((raw as any)?.tabId), (raw as any)?.emulation, "renderer")
  );
  handle("pideck:sim-viewport", (_e, raw: unknown) =>
    ctl().setViewport(str((raw as any)?.tabId), (raw as any)?.viewport)
  );
  handle("pideck:sim-zoom", (_e, raw: unknown) =>
    ctl().setZoomFactor(str((raw as any)?.tabId), (raw as any)?.factor)
  );
  handle("pideck:sim-fit-zoom", (_e, raw: unknown) => {
    ctl().setFitZoom(str((raw as any)?.tabId) ?? null, (raw as any)?.scale);
  });
  handle("pideck:sim-hard-reload", (_e, raw: unknown) =>
    ctl().hardReload(str((raw as any)?.tabId) ?? null)
  );
  handle("pideck:sim-devtools", (_e, raw: unknown) => {
    ctl().openDevTools(str((raw as any)?.tabId) ?? null);
  });
  handle("pideck:sim-clear-cookies", (_e, raw: unknown) =>
    ctl().clearCookies(str((raw as any)?.tabId) ?? null)
  );
  handle("pideck:sim-clear-cache", (_e, raw: unknown) =>
    ctl().clearCache(str((raw as any)?.tabId) ?? null)
  );
  handle("pideck:sim-navigate", (_e, raw: unknown) => {
    const url = str((raw as any)?.url);
    if (!url) throw new Error("url is required");
    return ctl().navigate(str((raw as any)?.tabId), url);
  });
  handle("pideck:sim-reload", (_e, raw: unknown) => {
    ctl().reload(str((raw as any)?.tabId) ?? null);
  });
  handle("pideck:sim-back", (_e, raw: unknown) => {
    ctl().back(str((raw as any)?.tabId) ?? null);
  });
  handle("pideck:sim-forward", (_e, raw: unknown) => {
    ctl().forward(str((raw as any)?.tabId) ?? null);
  });
  handle("pideck:sim-probe", async (_e, rawPort: unknown) => {
    const port = typeof rawPort === "number" ? rawPort : Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    return { open: await probePort(port) };
  });
  // Native options menu. DOM popovers render UNDER the guest view (separate
  // OS surface), so the ⋮ menu must be a real Menu.popup to be visible.
  handle("pideck:sim-menu", (e, raw: unknown) => {
    const c = ctl();
    const tabId = str((raw as any)?.tabId) ?? null;
    const showDeviceToolbar = (raw as any)?.showDeviceToolbar === true;
    const tab = tabId ? c.listTabs().tabs.find((t) => t.id === tabId) ?? null : null;
    const zoom = tab?.zoomFactor ?? 1;
    let result: { deviceToolbar?: boolean; dismissed?: boolean } = { dismissed: true };
    const run = (fn: () => unknown) => {
      try {
        const r = fn() as Promise<unknown> | undefined;
        (r as Promise<unknown> | undefined)?.catch?.(() => undefined);
      } catch {
        /* menu action failed: nothing to show */
      }
    };
    const menu = Menu.buildFromTemplate([
      { label: "Hard reload", enabled: !!tab, click: () => run(() => c.hardReload(tabId)) },
      { label: "Open DevTools", enabled: !!tab, click: () => run(() => c.openDevTools(tabId)) },
      { type: "separator" },
      {
        label: "Show device toolbar",
        type: "checkbox",
        checked: showDeviceToolbar,
        click: (item) => {
          result = { deviceToolbar: item.checked };
        },
      },
      { type: "separator" },
      { label: `Zoom: ${Math.round(zoom * 100)}%`, enabled: false },
      { label: "Zoom in", enabled: !!tab, click: () => run(() => c.setZoomFactor(tabId, zoom * 1.25)) },
      { label: "Zoom out", enabled: !!tab, click: () => run(() => c.setZoomFactor(tabId, zoom / 1.25)) },
      { label: "Reset zoom", enabled: !!tab, click: () => run(() => c.setZoomFactor(tabId, 1)) },
      { type: "separator" },
      { label: "Clear cookies", enabled: !!tab, click: () => run(() => c.clearCookies(tabId)) },
      { label: "Clear cache", enabled: !!tab, click: () => run(() => c.clearCache(tabId)) },
    ]);
    return new Promise((resolve) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      menu.popup({ window: win, callback: () => resolve(result) });
    });
  });
}
