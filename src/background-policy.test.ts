import { describe, expect, it } from "vitest";
import {
  canRunInBackground,
  defaultPolicy,
  type BackgroundMode,
  type EnvironmentSignals,
} from "./background-policy";

function signals(over: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0, ...over };
}

describe("background execution policies", () => {
  it("allows the default policy while plugged in", () => {
    expect(canRunInBackground(defaultPolicy(), "p", signals()).allowed).toBe(true);
  });

  it("denies when mode is never", () => {
    const d = canRunInBackground({ ...defaultPolicy(), mode: "never" }, "p", signals());
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/never/);
  });

  it("denies while-plugged-in on battery", () => {
    const d = canRunInBackground(defaultPolicy(), "p", signals({ onBattery: true }));
    expect(d.allowed).toBe(false);
  });

  it("allows always on battery when pause-on-battery is off", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), mode: "always", pauseOnBattery: false },
      "p",
      signals({ onBattery: true })
    );
    expect(d.allowed).toBe(true);
  });

  it("denies always on battery when pause-on-battery is on", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), mode: "always", pauseOnBattery: true },
      "p",
      signals({ onBattery: true })
    );
    expect(d.allowed).toBe(false);
  });

  it("denies when asleep and pause-on-sleep is on", () => {
    const d = canRunInBackground(defaultPolicy(), "p", signals({ asleep: true }));
    expect(d.allowed).toBe(false);
  });

  it("denies at the concurrency limit", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), maxConcurrentAgents: 4 },
      "p",
      signals({ activeAgents: 4 })
    );
    expect(d.allowed).toBe(false);
  });

  it("denies at the cost limit", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), maxBackgroundCost: 10 },
      "p",
      signals({ currentCost: 10 })
    );
    expect(d.allowed).toBe(false);
  });

  it("denies a project explicitly denied", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), perProjectPermission: { p: false } },
      "p",
      signals()
    );
    expect(d.allowed).toBe(false);
  });

  it("does not throw when perProjectPermission is absent or empty", () => {
    const withEmpty = { ...defaultPolicy(), perProjectPermission: {} };
    expect(canRunInBackground(withEmpty, "p", signals()).allowed).toBe(true);
    const without = defaultPolicy() as unknown as Record<string, unknown>;
    delete without.perProjectPermission;
    expect(canRunInBackground(without as never, "p", signals()).allowed).toBe(true);
  });

  it("denies an unknown background mode", () => {
    const d = canRunInBackground(
      { ...defaultPolicy(), mode: "alwaysX" as BackgroundMode },
      "p",
      signals({ onBattery: true })
    );
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/Unknown/);
  });

  it("denies when a signal is NaN", () => {
    const d = canRunInBackground(defaultPolicy(), "p", signals({ currentCost: NaN }));
    expect(d.allowed).toBe(false);
  });
});
