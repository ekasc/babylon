import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { collectDiagnosticsEffect } from "./diagnostics.effect";
import { createAttentionRegistry } from "./attention";
import { createScheduledTaskRegistry } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { defaultPolicy } from "./background-policy";
import { createDeviceRegistry } from "./device-pairing";

describe("diagnostics.effect", () => {
  it("collects via Effect", async () => {
    const snap = await Effect.runPromise(
      collectDiagnosticsEffect({
        now: Date.now(),
        attention: createAttentionRegistry(),
        processes: { processes: {} },
        schedule: createScheduledTaskRegistry(),
        history: createAutomationHistory(),
        policy: defaultPolicy(),
        devices: createDeviceRegistry(),
        events: { events: [] },
      }),
    );
    expect(snap).toBeDefined();
  });
});
