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

  it("retains a reference whose successor is route-incompatible", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    // CHAT-LATEST is platform-only; on the subscription route the provider
    // returns an explicit incompatible route decision without an
    // authoritative flag, which must still block the migration.
    expect(resolve({ modelRef: "openai/retired-incompat-chain", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
  });

  it("retains a provider-wide retirement whose successor is retired on this route", async () => {
    const { cfg, state } = await fixture("oauth");
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    // retired-global-parent retires provider-wide (no route condition), while
    // retired-route-child is retired only on the subscription route. An
    // unconditional-only lookup would miss it and migrate onto a retired model.
    expect(resolve({ modelRef: "openai/retired-global-parent", agentId: "main" })).toEqual({
      kind: "unchanged",
    });
    expect(warnings.join("\n")).toContain("successor");
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

  it("still migrates when the route is in cooldown", async () => {
    const { cfg, state } = await fixture("oauth");
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        chatgpt: {
          provider: "openai",
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 9_999_999_999_999,
        },
        platform: { provider: "openai", type: "api_key", key: "synthetic-key" },
      },
      usageStats: { chatgpt: { cooldownUntil: Date.now() + 60_000 } },
    });
    const warnings: string[] = [];
    const resolve = createRetiredModelRefRepairResolver({
      cfg,
      env: state.env,
      warnings,
    });
    // A transient cooldown is not proof the successor is unsupported.
    expect(resolve({ modelRef: "openai/retired-with-successor", agentId: "main" })).toEqual({
      kind: "replace",
      modelRef: "openai/current-model",
      reason: "retirement",
      retirementScope: "route",
    });
  });
});
