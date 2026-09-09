import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const cfg = { agents: { entries: { ops: {} } } };
  const snapshot = { kind: "account-secret-snapshot" };
  return {
    cfg,
    snapshot,
    prepareSecretsRuntimeSnapshot: vi.fn(async () => snapshot),
    activateSecretsRuntimeSnapshot: vi.fn(),
    releasePreparedModel: vi.fn(),
    acquireSimpleCompletionModelForAgent: vi.fn(async () => ({
      selection: { provider: "openai", modelId: "gpt-test", agentDir: "/tmp/agent-ops" },
      model: { provider: "openai", id: "gpt-test", maxTokens: 128 },
      auth: { apiKey: "synthetic-runtime-key", source: "profile:openai:test", mode: "api-key" },
      release: mocks.releasePreparedModel,
    })),
    completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    })),
    emitJsonOrText: vi.fn(),
  };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentDir: (_cfg: unknown, agentId: string) => `/tmp/agent-${agentId}`,
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection.js")>()),
  canonicalizeCaseOnlyCatalogModelRef: vi.fn(async ({ raw }: { raw?: string }) => raw),
}));

vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: mocks.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: mocks.completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: mocks.prepareSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshot: mocks.activateSecretsRuntimeSnapshot,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: mocks.emitJsonOrText,
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  requireProviderModelOverride: vi.fn(() => undefined),
  resolveCapabilityAgentOption: vi.fn((_command: unknown, rawAgentId: unknown) => rawAgentId),
  resolveCapabilityProviderAgentId: vi.fn((_cfg: unknown, rawAgentId: unknown) =>
    typeof rawAgentId === "string" ? rawAgentId : "ops",
  ),
  resolveLocalCapabilityRuntimeConfig: vi.fn(async () => mocks.cfg),
  resolveTransport: vi.fn(() => "local"),
}));

import { registerModelCapabilityCommands } from "./model.js";

describe("local model run account secret activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("activates an isolated selected-agent auth snapshot before preparing model auth", async () => {
    const capability = new Command();
    registerModelCapabilityCommands(capability);

    await capability.parseAsync(["model", "run", "--prompt", "hello", "--agent", "ops", "--json"], {
      from: "user",
    });

    expect(mocks.prepareSecretsRuntimeSnapshot).toHaveBeenCalledWith({
      config: mocks.cfg,
      assignmentConfig: mocks.cfg,
      agentDirs: ["/tmp/agent-ops"],
      includeConfigRefs: false,
      allowUnavailableSecretOwners: true,
    });
    expect(mocks.activateSecretsRuntimeSnapshot).toHaveBeenCalledWith(mocks.snapshot);
    expect(mocks.acquireSimpleCompletionModelForAgent).toHaveBeenCalledTimes(1);

    const activationOrder = mocks.activateSecretsRuntimeSnapshot.mock.invocationCallOrder[0];
    const authLookupOrder = mocks.acquireSimpleCompletionModelForAgent.mock.invocationCallOrder[0];
    if (authLookupOrder === undefined) {
      throw new Error("expected model auth preparation to run after snapshot activation");
    }
    expect(activationOrder).toBeLessThan(authLookupOrder);
    expect(mocks.releasePreparedModel).toHaveBeenCalledTimes(1);
  });
});
