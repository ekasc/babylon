import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SIM_PRESETS, buildEmulation } from "../src/lib/simulator";
import type { SimController } from "./sim-controller";

const PRESET_IDS = SIM_PRESETS.map((p) => p.id);

function textResult(t: string) {
  return { content: [{ type: "text", text: t }], details: { text: t } };
}

function tabParam(description = "Tab id (defaults to the active tab; see browser_list_tabs)"): any {
  return { type: "string", description };
}

function needCtl(getController: () => SimController | null): SimController {
  const ctl = getController();
  if (!ctl) throw new Error("browser tools unavailable: simulator is not initialized");
  return ctl;
}

async function stateLine(ctl: SimController, note: string, tabId?: string): Promise<{ content: any[]; details: any }> {
  const snap = await ctl.snapshot(tabId).catch(() => null);
  const line = snap ? `${note} — ${snap.title || "(no title)"} · ${snap.url}` : note;
  return { content: [{ type: "text", text: line }], details: snap ? { note, ...snap, text: snap.text.slice(0, 500) } : { note } };
}

function checkPreset(raw: unknown): string {
  const preset = String(raw ?? "");
  if (!PRESET_IDS.includes(preset)) throw new Error(`unknown preset ${preset || "(missing)"} — one of: ${PRESET_IDS.join(", ")}`);
  return preset;
}

/**
 * Agent tools driving the shared in-app browser: tabbed Chromium guests with
 * device emulation, mirrored in the sidebar. Opening or navigating from here
 * also opens the sidebar for the user.
 */
export function createBrowserTools(getController: () => SimController | null): ToolDefinition<any, any>[] {
  const tools: ToolDefinition<any, any>[] = [
    {
      name: "browser_open",
      label: "Open Browser",
      description:
        "Open a URL in Babylon's in-app browser (tabbed Chromium guests with device emulation). Reuses the active tab unless newTab is true. The sidebar mirrors the same tabs for the user. Tabs share one cookie jar that survives restarts, so logins stick. Prefer browser_navigate when a page is already open.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "http(s) URL to open" },
          newTab: { type: "boolean", description: "Open in a fresh tab instead of reusing the active one" },
          preset: { type: "string", enum: PRESET_IDS, description: "Device/browser preset to emulate" },
          rotated: { type: "boolean", description: "Landscape for rotatable (mobile) presets" },
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = String((raw as any)?.url ?? "").trim();
        if (!url) throw new Error("browser_open: url is required");
        const snap = ctl.listTabs();
        const reuseId = (raw as any)?.newTab === true || !snap.activeId ? undefined : snap.activeId;
        const tab = await ctl.openTab(reuseId ? { url, tabId: reuseId } : { url });
        const preset = typeof (raw as any)?.preset === "string" ? checkPreset((raw as any).preset) : null;
        if (preset) await ctl.setEmulation(tab.id, buildEmulation(preset, (raw as any)?.rotated === true), "agent");
        return stateLine(ctl, `Opened ${url} in tab ${tab.id}`, tab.id);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_new_tab",
      label: "New Browser Tab",
      description: "Open an http(s) URL in a fresh in-app browser tab and activate it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string", description: "http(s) URL to open" } },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = String((raw as any)?.url ?? "").trim();
        if (!url) throw new Error("browser_new_tab: url is required");
        const tab = await ctl.openTab({ url });
        return stateLine(ctl, `Opened ${url} in tab ${tab.id}`, tab.id);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_list_tabs",
      label: "List Browser Tabs",
      description: "List the in-app browser tabs: id, URL, title, and which is active.",
      parameters: { type: "object", additionalProperties: false, properties: {} } as any,
      execute: async () => {
        const ctl = needCtl(getController);
        const { tabs, activeId } = ctl.listTabs();
        if (!tabs.length) return textResult("No browser tabs open.");
        const lines = tabs.map((t) => `${t.id === activeId ? "●" : "○"} ${t.id} — ${t.title || "(no title)"} · ${t.url}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { tabs, activeId } };
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_activate_tab",
      label: "Activate Browser Tab",
      description: "Bring an in-app browser tab to the front by id (see browser_list_tabs).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tab"],
        properties: { tab: tabParam("Tab id to activate") },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = String((raw as any)?.tab ?? "").trim();
        if (!tab) throw new Error("browser_activate_tab: tab is required");
        await ctl.activate(tab);
        return stateLine(ctl, `Activated tab ${tab}`, tab);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_close_tab",
      label: "Close Browser Tab",
      description: "Close an in-app browser tab (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam("Tab id to close") },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        const { closed } = await ctl.closeTab(tab);
        return textResult(closed ? `Closed tab ${tab ?? "(active)"}.` : "No tab to close.");
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_navigate",
      label: "Navigate Browser",
      description: "Navigate an in-app browser tab to an http(s) URL (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "http(s) URL to navigate to" },
          tab: tabParam(),
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = String((raw as any)?.url ?? "").trim();
        if (!url) throw new Error("browser_navigate: url is required");
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : undefined;
        await ctl.navigate(tab, url);
        return stateLine(ctl, `Navigated to ${url}`, tab);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_reload",
      label: "Reload Browser",
      description: "Reload an in-app browser tab (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        ctl.reload(tab);
        return stateLine(ctl, "Reloaded", tab ?? undefined);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_back",
      label: "Browser Back",
      description: "Go back one entry in an in-app browser tab's history (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        ctl.back(tab);
        return stateLine(ctl, "Went back", tab ?? undefined);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_forward",
      label: "Browser Forward",
      description: "Go forward one entry in an in-app browser tab's history (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        ctl.forward(tab);
        return stateLine(ctl, "Went forward", tab ?? undefined);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_emulate",
      label: "Emulate Device",
      description:
        "Emulate a device/browser preset in an in-app browser tab (defaults to the active tab): real viewport, device DPR, device user agent, and touch on mobiles. The engine stays Chromium; presets change what the page sees, not the engine.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["preset"],
        properties: {
          preset: { type: "string", enum: PRESET_IDS, description: "Device/browser preset to emulate" },
          rotated: { type: "boolean", description: "Landscape for rotatable (mobile) presets" },
          tab: tabParam(),
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const preset = checkPreset((raw as any)?.preset);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : undefined;
        await ctl.ensureOpen();
        await ctl.setEmulation(tab, buildEmulation(preset, (raw as any)?.rotated === true), "agent");
        const label = SIM_PRESETS.find((p) => p.id === preset)?.label ?? preset;
        return textResult(`Emulating ${label}${(raw as any)?.rotated === true ? " (landscape)" : ""}`);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_screenshot",
      label: "Screenshot Browser",
      description: "Capture an in-app browser tab as a PNG image (capped at 1440px wide, defaults to the active tab). Pass fullPage for the whole page height instead of just the viewport. The image is returned to you; use it to verify layout, styling, and visual state.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tab: tabParam(),
          fullPage: { type: "boolean", description: "Capture beyond the viewport (full page height)" },
        },
      } as any,
      execute: async (_id, raw, _signal, onUpdate) => {
        const ctl = needCtl(getController);
        onUpdate?.({ content: [{ type: "text", text: "Capturing screenshot…" }], details: {} });
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        await ctl.ensureOpen();
        const shot = await ctl.screenshot(tab, { fullPage: (raw as any)?.fullPage === true });
        const snap = await ctl.snapshot(tab).catch(() => null);
        return {
          content: [
            { type: "text", text: `Screenshot ${shot.width}×${shot.height}${snap ? ` of ${snap.url}` : ""}` },
            { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
          ],
          details: { width: shot.width, height: shot.height, url: snap?.url ?? null },
        };
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_snapshot",
      label: "Read Browser Page",
      description: "Read an in-app browser tab (defaults to the active tab): URL, title, rendered text, and the interactive-element tree with [ref:N] markers. Use this to check content and state without a screenshot; target refs with browser_click/browser_fill (e.g. selector ref:3). Refs are valid until the next navigation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : null;
        await ctl.ensureOpen();
        const snap = await ctl.snapshot(tab, { a11y: true });
        const body = [`URL: ${snap.url}\nTitle: ${snap.title || "(none)"}\n\n${snap.text || "(no text)"}`];
        if (snap.a11y) body.push(`Interactive elements (click/fill with selector "ref:N"):\n${snap.a11y}`);
        return {
          content: [{ type: "text", text: body.join("\n\n") }],
          details: { url: snap.url, title: snap.title, chars: snap.text.length, axChars: snap.a11y.length },
        };
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_click",
      label: "Click Browser Element",
      description: "Click an element in an in-app browser tab by CSS selector (e.g. \"button.submit\", \"a[href='/login']\", \"#menu-toggle\") or by snapshot ref (e.g. \"ref:3\"). Defaults to the active tab. Uses touch taps under mobile emulation, mouse clicks otherwise. The element must exist and be visible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector"],
        properties: {
          selector: { type: "string", description: "CSS selector of the element to click, or a ref:N marker from the latest browser_snapshot" },
          tab: tabParam(),
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const selector = String((raw as any)?.selector ?? "");
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : undefined;
        await ctl.ensureOpen();
        const at = await ctl.click(tab, selector);
        return textResult(`Clicked ${selector} at ${at.x},${at.y}${at.text ? ` (“${at.text}”)` : ""}`);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_fill",
      label: "Fill Browser Field",
      description: "Type text into a text field in an in-app browser tab by CSS selector (input, textarea, or contenteditable) or by snapshot ref (e.g. \"ref:3\"). Defaults to the active tab. Existing content is selected first, then replaced. The element must exist and be visible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector", "text"],
        properties: {
          selector: { type: "string", description: "CSS selector of the field, or a ref:N marker from the latest browser_snapshot" },
          text: { type: "string", description: "Text to type" },
          tab: tabParam(),
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const selector = String((raw as any)?.selector ?? "");
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : undefined;
        await ctl.ensureOpen();
        const { value } = await ctl.fill(tab, selector, String((raw as any)?.text ?? ""));
        return textResult(`Filled ${selector} — field now reads: “${value.slice(0, 200)}”`);
      },
    } as ToolDefinition<any, any>,

    {
      name: "browser_evaluate",
      label: "Evaluate Browser JS",
      description: "Run a JavaScript expression in an in-app browser tab (defaults to the active tab) and return its JSON result (capped). Escape hatch for state checks the other tools cannot express (e.g. \"document.querySelectorAll('.card').length\"). Read-only preferred; mutations are allowed but click/fill cover interaction.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["expression"],
        properties: {
          expression: { type: "string", description: "JavaScript expression to evaluate" },
          tab: tabParam(),
        },
      } as any,
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const expression = String((raw as any)?.expression ?? "");
        const tab = typeof (raw as any)?.tab === "string" && (raw as any).tab ? (raw as any).tab : undefined;
        await ctl.ensureOpen();
        const out = await ctl.evaluate(tab, expression);
        return {
          content: [{ type: "text", text: out.result }],
          details: { chars: out.result.length },
        };
      },
    } as ToolDefinition<any, any>,
  ];
  return tools;
}
