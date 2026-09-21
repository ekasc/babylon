import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildEmulation } from "../src/lib/simulator";
import {
  PRESET_IDS,
  checkPreset,
  emulateResult,
  formatTabList,
  parseTabArg,
  parseTabArgOptional,
  requireSelector,
  requireTabId,
  requireUrl,
  reuseTabId,
  snapshotBody,
  tabParam,
  textResult,
} from "./sim-tool-helpers";
import type { SimController } from "./sim-controller";

function needCtl(getController: () => SimController | null): SimController {
  const ctl = getController();
  if (!ctl) throw new Error("browser tools unavailable: simulator is not initialized");
  return ctl;
}

async function stateLine(
  ctl: SimController,
  note: string,
  tabId?: string
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const snap = await ctl.snapshot(tabId).catch(() => null);
  const line = snap ? `${note} — ${snap.title || "(no title)"} · ${snap.url}` : note;
  return { content: [{ type: "text" as const, text: line }], details: snap ? { note, ...snap, text: snap.text.slice(0, 500) } : { note } };
}

/**
 * Agent tools driving the shared in-app browser: tabbed Chromium guests with
 * device emulation, mirrored in the sidebar. Opening or navigating from here
 * also opens the sidebar for the user.
 */
export function createBrowserTools(getController: () => SimController | null): ToolDefinition[] {
  const tools: ToolDefinition[] = [
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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = requireUrl(raw, "browser_open");
        const snap = ctl.listTabs();
        const reuseId = reuseTabId(snap.activeId, (raw as { newTab?: unknown } | null | undefined)?.newTab);
        const tab = await ctl.openTab(reuseId ? { url, tabId: reuseId } : { url });
        const rawOpts = raw as { preset?: unknown; rotated?: unknown } | null | undefined;
        const preset = typeof rawOpts?.preset === "string" ? checkPreset(rawOpts.preset) : null;
        if (preset) await ctl.setEmulation(tab.id, buildEmulation(preset, rawOpts?.rotated === true), "agent");
        return stateLine(ctl, `Opened ${url} in tab ${tab.id}`, tab.id);
      },
    },

    {
      name: "browser_new_tab",
      label: "New Browser Tab",
      description: "Open an http(s) URL in a fresh in-app browser tab and activate it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string", description: "http(s) URL to open" } },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = requireUrl(raw, "browser_new_tab");
        const tab = await ctl.openTab({ url });
        return stateLine(ctl, `Opened ${url} in tab ${tab.id}`, tab.id);
      },
    },

    {
      name: "browser_list_tabs",
      label: "List Browser Tabs",
      description: "List the in-app browser tabs: id, URL, title, and which is active.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const ctl = needCtl(getController);
        const { tabs, activeId } = ctl.listTabs();
        const text = formatTabList(tabs, activeId);
        if (text === "No browser tabs open.") return textResult(text);
        return { content: [{ type: "text", text }], details: { tabs, activeId } };
      },
    },

    {
      name: "browser_activate_tab",
      label: "Activate Browser Tab",
      description: "Bring an in-app browser tab to the front by id (see browser_list_tabs).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tab"],
        properties: { tab: tabParam("Tab id to activate") },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = requireTabId(raw);
        await ctl.activate(tab);
        return stateLine(ctl, `Activated tab ${tab}`, tab);
      },
    },

    {
      name: "browser_close_tab",
      label: "Close Browser Tab",
      description: "Close an in-app browser tab (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam("Tab id to close") },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = parseTabArg(raw);
        const { closed } = await ctl.closeTab(tab);
        return textResult(closed ? `Closed tab ${tab ?? "(active)"}.` : "No tab to close.");
      },
    },

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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const url = requireUrl(raw, "browser_navigate");
        const tab = parseTabArgOptional(raw);
        await ctl.navigate(tab, url);
        return stateLine(ctl, `Navigated to ${url}`, tab);
      },
    },

    {
      name: "browser_reload",
      label: "Reload Browser",
      description: "Reload an in-app browser tab (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = parseTabArg(raw);
        ctl.reload(tab);
        return stateLine(ctl, "Reloaded", tab ?? undefined);
      },
    },

    {
      name: "browser_back",
      label: "Browser Back",
      description: "Go back one entry in an in-app browser tab's history (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = parseTabArg(raw);
        ctl.back(tab);
        return stateLine(ctl, "Went back", tab ?? undefined);
      },
    },

    {
      name: "browser_forward",
      label: "Browser Forward",
      description: "Go forward one entry in an in-app browser tab's history (defaults to the active tab).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = parseTabArg(raw);
        ctl.forward(tab);
        return stateLine(ctl, "Went forward", tab ?? undefined);
      },
    },

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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const preset = checkPreset((raw as { preset?: unknown } | null | undefined)?.preset);
        const tab = parseTabArgOptional(raw);
        await ctl.ensureOpen();
        const rawRot = raw as { rotated?: unknown } | null | undefined;
        await ctl.setEmulation(tab, buildEmulation(preset, rawRot?.rotated === true), "agent");
        return textResult(emulateResult(preset, rawRot?.rotated));
      },
    },

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
      },
      execute: async (_id, raw, _signal, onUpdate) => {
        const ctl = needCtl(getController);
        onUpdate?.({ content: [{ type: "text", text: "Capturing screenshot…" }], details: {} });
        const tab = parseTabArg(raw);
        await ctl.ensureOpen();
        const fullPage = (raw as { fullPage?: unknown } | null | undefined)?.fullPage === true;
        const shot = await ctl.screenshot(tab, { fullPage });
        const snap = await ctl.snapshot(tab).catch(() => null);
        return {
          content: [
            { type: "text", text: `Screenshot ${shot.width}×${shot.height}${snap ? ` of ${snap.url}` : ""}` },
            { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
          ],
          details: { width: shot.width, height: shot.height, url: snap?.url ?? null },
        };
      },
    },

    {
      name: "browser_snapshot",
      label: "Read Browser Page",
      description: "Read an in-app browser tab (defaults to the active tab): URL, title, rendered text, and the interactive-element tree with [ref:N] markers. Use this to check content and state without a screenshot; target refs with browser_click/browser_fill (e.g. selector ref:3). Refs are valid until the next navigation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tab: tabParam() },
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const tab = parseTabArg(raw);
        await ctl.ensureOpen();
        const snap = await ctl.snapshot(tab, { a11y: true });
        const text = snapshotBody(snap);
        return {
          content: [{ type: "text", text }],
          details: { url: snap.url, title: snap.title, chars: snap.text.length, axChars: snap.a11y.length },
        };
      },
    },

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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const selector = requireSelector(raw, "browser_click");
        const tab = parseTabArgOptional(raw);
        await ctl.ensureOpen();
        const at = await ctl.click(tab, selector);
        return textResult(`Clicked ${selector} at ${at.x},${at.y}${at.text ? ` (“${at.text}”)` : ""}`);
      },
    },

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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const selector = requireSelector(raw, "browser_fill");
        const tab = parseTabArgOptional(raw);
        await ctl.ensureOpen();
        const fillText = String((raw as { text?: unknown } | null | undefined)?.text ?? "");
        const { value } = await ctl.fill(tab, selector, fillText);
        return textResult(`Filled ${selector} — field now reads: “${value.slice(0, 200)}”`);
      },
    },

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
      },
      execute: async (_id, raw) => {
        const ctl = needCtl(getController);
        const expression = String((raw as { expression?: unknown } | null | undefined)?.expression ?? "");
        const tab = parseTabArgOptional(raw);
        await ctl.ensureOpen();
        const out = await ctl.evaluate(tab, expression);
        return {
          content: [{ type: "text", text: out.result }],
          details: { chars: out.result.length },
        };
      },
    },
  ];
  return tools;
}
