import { describe, expect, it } from "vitest";
import {
  clearRole,
  createModelRolesState,
  listConfiguredRoles,
  mergeRoleConfig,
  resolveRole,
  setRole,
  type ModelRolesState,
} from "./model-roles";

const BASE = { provider: "acme", model: "big-model", reasoning: "high" };

describe("model roles", () => {
  it("merges override over base without letting undefined win", () => {
    expect(mergeRoleConfig(BASE, { model: "small" })).toEqual({
      provider: "acme",
      model: "small",
      reasoning: "high",
    });
    expect(mergeRoleConfig(undefined, { model: "x" })).toEqual({ model: "x" });
  });

  it("ignores an explicit undefined in the override", () => {
    expect(mergeRoleConfig({ model: "big", tokenBudget: 100 }, { model: undefined })).toEqual({
      model: "big",
      tokenBudget: 100,
    });
  });

  it("merges setRole calls so fields accumulate", () => {
    let s = createModelRolesState();
    s = setRole(s, "scout", { model: "haiku" });
    s = setRole(s, "scout", { tokenBudget: 500 });
    expect(s.roles.scout).toEqual({ model: "haiku", tokenBudget: 500 });
  });

  it("sets and clears roles immutably", () => {
    let s: ModelRolesState = createModelRolesState();
    s = setRole(s, "scout", { model: "haiku", tokenBudget: 1000 });
    expect(s.roles.scout).toEqual({ model: "haiku", tokenBudget: 1000 });
    s = clearRole(s, "scout");
    expect(s.roles.scout).toBeUndefined();
  });

  it("resolves a role by layering its override onto a base", () => {
    let s = createModelRolesState();
    s = setRole(s, "scout", { model: "haiku", tokenBudget: 500 });
    expect(resolveRole(s, "scout", BASE)).toEqual({
      provider: "acme",
      model: "haiku",
      reasoning: "high",
      tokenBudget: 500,
    });
  });

  it("falls back to the base when a role has no override", () => {
    const s = createModelRolesState();
    expect(resolveRole(s, "reviewer", BASE)).toEqual(BASE);
  });

  it("lists only configured roles", () => {
    let s = createModelRolesState();
    s = setRole(s, "planner", { model: "mini" });
    s = setRole(s, "title", { model: "mini" });
    expect(listConfiguredRoles(s).sort()).toEqual(["planner", "title"]);
  });
});
