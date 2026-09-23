import { describe, expect, it } from "vitest";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./doctor/shared/retired-model-ref-repair.js";

// Regression coverage for openclaw/openclaw#156155: Doctor must not migrate a
// retired reference onto a successor that the owner cannot support. A successor
// that is itself retired is definitionally unsupported: writing it into
// selectors, fallbacks, and modelPolicy.allow converts a visible retirement
// warning into a latent unusable reference.
describe("doctor retired successor guard", () => {
  it("retains a reference whose successor is itself retired", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    expect(resolve({ modelRef: "openai/retired-chain-to-retired", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
  });

  it("still migrates onto a supported successor", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    expect(resolve({ modelRef: "openai/retired-with-successor", agentId: "main" })).toEqual({
      kind: "replace",
      modelRef: "openai/current-model",
      reason: "retirement",
      retirementScope: "route",
    });
  });

  it("does not write an unsupported successor into fallbacks and policy allow", async () => {
    const { cfg, state } = await fixture("oauth");
    cfg.agents!.defaults!.model = {
      primary: "openai/retired-chain-to-retired",
      fallbacks: ["openai/retired-chain-to-retired", "openai/current-model"],
    };
    cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-chain-to-retired"] };
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    const repaired = repairRetiredConfigModelRefs(cfg, resolve, warnings);
    expect(repaired.config.agents?.defaults?.model).toEqual({
      primary: "openai/retired-chain-to-retired",
      fallbacks: ["openai/retired-chain-to-retired", "openai/current-model"],
    });
    expect(repaired.config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/retired-chain-to-retired",
    ]);
    expect(warnings.join("\n")).toContain("successor");
  });
});
