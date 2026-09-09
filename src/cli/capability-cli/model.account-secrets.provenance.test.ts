/** Local `model run` must preserve config SecretRef provenance through snapshot activation. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { resolveProviderConfigSecretInput } from "../../agents/model-auth-provider-config.js";
import {
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../secrets/runtime.test-support.ts";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../secrets/sentinel.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

const { prepareSecretsRuntimeSnapshot: _prepareHook } = setupSecretsRuntimeSnapshotTestHooks();
void _prepareHook;

import type { OpenClawConfig } from "../../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  rawCfg: {} as OpenClawConfig,
  completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
    content: [{ type: "text", text: "synthetic-ok" }],
  })),
  emitJsonOrText: vi.fn(),
}));

const completeWithPreparedSimpleCompletionModelMock =
  hoisted.completeWithPreparedSimpleCompletionModel;
const emitJsonOrTextMock = hoisted.emitJsonOrText;

vi.mock("../../agents/simple-completion-execution.js", () => ({
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => hoisted.rawCfg,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
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

vi.mock("./output.js", () => ({
  emitJsonOrText: hoisted.emitJsonOrText,
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

import { registerModelCapabilityCommands } from "./model.js";

// Synthetic-only credentials for local-path proof. Never real keys or endpoints.
const ENV_CONFIG_KEY = "OPENCLAW_TEST_PROVENANCE_CONFIG_KEY";
const ENV_ACCOUNT_KEY = "OPENCLAW_TEST_PROVENANCE_ACCOUNT_KEY";
const ENV_MISSING_KEY = "OPENCLAW_TEST_PROVENANCE_MISSING_KEY";
// Deliberately collides with the decoy profile id below: without SecretRef
// provenance the resolved bytes are misread as a profile reference.
const CONFIG_KEY_VALUE = "customcfg:decoy"; // pragma: allowlist secret
const ACCOUNT_KEY_VALUE = "synthetic-account-key"; // pragma: allowlist secret

function buildRawCfg(agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: join(agentDir, "workspace") },
      entries: {
        ops: { agentDir, model: "customcfg/test-model" },
      },
    },
    models: {
      providers: {
        customcfg: {
          api: "openai-completions",
          auth: "api-key",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: { source: "env", provider: "default", id: ENV_CONFIG_KEY },
          models: [{ id: "test-model" }],
        },
        customacct: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{ id: "test-model" }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function seedProfiles(
  agentDir: string,
  profiles: AuthProfileStore["profiles"],
): Promise<void> {
  await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      Object.assign(store.profiles, profiles);
      return true;
    },
  });
}

function seedStandardProfiles(agentDir: string): Promise<void> {
  return seedProfiles(agentDir, {
    "customcfg:decoy": {
      type: "api_key",
      provider: "customcfg",
      key: "synthetic-decoy-key", // pragma: allowlist secret
    },
    "customacct:healthy": {
      type: "api_key",
      provider: "customacct",
      keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
    },
  });
}

async function runLocalModelRun(model: string): Promise<void> {
  const capability = new Command();
  registerModelCapabilityCommands(capability);
  await capability.parseAsync(
    ["model", "run", "--prompt", "hello", "--agent", "ops", "--model", model, "--local", "--json"],
    { from: "user" },
  );
}

type CompletionAuth = { apiKey?: string; source?: string };

/** Reads the auth captured by the faked provider-egress boundary. */
function getCompletionAuth(): CompletionAuth | undefined {
  const args = completeWithPreparedSimpleCompletionModelMock.mock.calls.at(-1) as
    | unknown[]
    | undefined;
  const params = args?.[0] as { auth?: CompletionAuth } | undefined;
  return params?.auth;
}

describe("local model run config SecretRef provenance", () => {
  let agentDir = "";
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "openclaw-model-run-prov-"));
    hoisted.rawCfg = buildRawCfg(agentDir);
    // Replicate production CLI boot (config-guard pins the authored raw config
    // as the runtime source before any command runs). Without this the helper
    // would fall back to the resolved config, exactly like a bootless process.
    setRuntimeConfigSnapshot(structuredClone(hoisted.rawCfg), structuredClone(hoisted.rawCfg));
    const capturedEnv = captureEnv([ENV_CONFIG_KEY, ENV_ACCOUNT_KEY, ENV_MISSING_KEY]);
    restoreEnv = () => capturedEnv.restore();
    setTestEnvValue(ENV_CONFIG_KEY, CONFIG_KEY_VALUE);
    setTestEnvValue(ENV_ACCOUNT_KEY, ACCOUNT_KEY_VALUE);
    deleteTestEnvValue(ENV_MISSING_KEY);
    completeWithPreparedSimpleCompletionModelMock.mockClear();
    emitJsonOrTextMock.mockClear();
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    clearSecretsRuntimeSnapshotState();
    // Best effort: the persisted auth store may still hold an OS file handle on Windows.
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures; the OS temp directory reclaims the directory.
    }
  });

  it("keeps the authored config SecretRef in the runtime source snapshot", async () => {
    await seedStandardProfiles(agentDir);
    await runLocalModelRun("customcfg/test-model");

    expect(emitJsonOrTextMock).toHaveBeenCalledTimes(1);
    const source = getRuntimeConfigSourceSnapshot();
    const { ref } = resolveProviderConfigSecretInput(source ?? undefined, "customcfg");
    expect(ref).toMatchObject({ source: "env", id: ENV_CONFIG_KEY });
  });

  it("sentinelizes the config-backed credential instead of leaking it as a literal", async () => {
    await seedStandardProfiles(agentDir);
    await runLocalModelRun("customcfg/test-model");

    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("models.providers.customcfg");
    expect(looksLikeSecretSentinel(auth?.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(CONFIG_KEY_VALUE);
  });

  it("materializes a persisted account SecretRef for the selected provider", async () => {
    await seedStandardProfiles(agentDir);
    await runLocalModelRun("customacct/test-model");

    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("profile:customacct:healthy");
    expect(looksLikeSecretSentinel(auth?.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(ACCOUNT_KEY_VALUE);
  });

  it("keeps a healthy selected provider usable while an unrelated sibling is unavailable", async () => {
    await seedProfiles(agentDir, {
      "otherprovider:cold": {
        type: "api_key",
        provider: "otherprovider",
        keyRef: { source: "env", provider: "default", id: ENV_MISSING_KEY },
      },
      "customacct:healthy": {
        type: "api_key",
        provider: "customacct",
        keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
      },
    });
    await runLocalModelRun("customacct/test-model");

    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("profile:customacct:healthy");
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(ACCOUNT_KEY_VALUE);
  });

  it("fails closed when the selected account SecretRef is unavailable", async () => {
    await seedProfiles(agentDir, {
      "customacct:healthy": {
        type: "api_key",
        provider: "customacct",
        keyRef: { source: "env", provider: "default", id: ENV_MISSING_KEY },
      },
    });

    await expect(runLocalModelRun("customacct/test-model")).rejects.toThrow();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });
});
