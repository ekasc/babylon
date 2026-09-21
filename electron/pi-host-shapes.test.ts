import { describe, expect, it } from "vitest";
import { toAgentModel, toSessionStats } from "./pi-host-shapes";

describe("toAgentModel", () => {
  it("projects the bridge fields and drops SDK extras", () => {
    expect(
      toAgentModel({
        provider: "acme",
        id: "m1",
        name: "M1",
        contextWindow: 100_000,
        cost: { input: 1, output: 2 },
        reasoning: true,
        input: ["text", "image"],
        supportsImages: true,
        secretSauce: "classified",
      } as unknown as Parameters<typeof toAgentModel>[0])
    ).toEqual({
      provider: "acme",
      id: "m1",
      name: "M1",
      contextWindow: 100_000,
      cost: { input: 1, output: 2, cacheRead: undefined },
      reasoning: true,
      supportsImages: true,
      vision: undefined,
      input: ["text", "image"],
      capabilities: undefined,
    });
  });

  it("rejects models without provider/id", () => {
    expect(toAgentModel(null)).toBeNull();
    expect(toAgentModel(undefined)).toBeNull();
    expect(toAgentModel({} as unknown as Parameters<typeof toAgentModel>[0])).toBeNull();
    expect(toAgentModel({ provider: "acme" } as unknown as Parameters<typeof toAgentModel>[0])).toBeNull();
  });

  it("coerces mistyped scalars to undefined", () => {
    const out = toAgentModel({ provider: "a", id: "b", contextWindow: "lots", cost: 5 } as unknown as Parameters<typeof toAgentModel>[0]);
    expect(out?.contextWindow).toBeUndefined();
    expect(out?.cost).toBeUndefined();
  });
});

describe("toSessionStats", () => {
  it("maps known fields and drops the rest", () => {
    expect(
      toSessionStats({
        userMessages: 3,
        tokens: { total: 100, input: 60, output: 40 },
        cost: 0.01,
        messages: [{ role: "user" }],
        liveTokenEstimate: 999,
      })
    ).toEqual({
      userMessages: 3,
      assistantMessages: undefined,
      toolCalls: undefined,
      toolResults: undefined,
      totalMessages: undefined,
      tokens: { total: 100, input: 60, output: 40, cacheRead: undefined, cacheWrite: undefined },
      cost: 0.01,
      contextUsage: undefined,
    });
  });

  it("tolerates malformed payloads", () => {
    expect(toSessionStats(null)).toEqual({
      userMessages: undefined,
      assistantMessages: undefined,
      toolCalls: undefined,
      toolResults: undefined,
      totalMessages: undefined,
      tokens: undefined,
      cost: undefined,
      contextUsage: undefined,
    });
    expect(toSessionStats({ tokens: "lots", cost: "free" })).toMatchObject({ tokens: undefined, cost: undefined });
  });
});
