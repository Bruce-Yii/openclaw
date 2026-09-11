import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
import { mocks } from "./doctor-health.test-support.js";

beforeEach(() => {
  mocks.config.mockReset();
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  mocks.service.mockReset();
  mocks.probePortUsage.mockReset().mockResolvedValue("free");
  mocks.packageRoot.mockReset();
  mocks.restartedHealthy = true;
  mocks.emulateNativeInstall = true;
  mocks.servicePlatform = undefined;
});

it("keeps loaded systemd identity for Doctor final service revalidation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = process.cwd();
    const cfg: OpenClawConfig = { gateway: { mode: "local" } };
    await state.writeConfig(cfg);
    mocks.config.mockReturnValue(cfg);
    mocks.packageRoot.mockReturnValue(root);

    let running = true;
    let stopped = false;
    const stoppedRuntimeReads: Array<{ requireLoaded?: boolean } | undefined> = [];
    const stop = vi.fn(async () => {
      running = false;
      stopped = true;
    });
    const restart = vi.fn(async () => {
      running = true;
      return { outcome: "completed" as const };
    });
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: {
        OPENCLAW_STATE_DIR: state.stateDir,
        OPENCLAW_CONFIG_PATH: state.configPath,
      },
    };

    mocks.service.mockReturnValue({
      label: "systemd",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      uninstall: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop,
      restart,
      isLoaded: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      hasInstalledDefinition: vi.fn(async () => true),
      readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
      readCommand: vi.fn(async () => command),
      readRuntime: vi.fn(async (_env: NodeJS.ProcessEnv, opts?: { requireLoaded?: boolean }) => {
        if (stopped) {
          stoppedRuntimeReads.push(opts);
        }
        return {
          status: running ? ("running" as const) : ("stopped" as const),
          systemd: opts?.requireLoaded ? { managerUid: 2001 } : {},
        };
      }),
    });

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

    expect(stop).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(stoppedRuntimeReads.length).toBeGreaterThan(0);
    expect(stoppedRuntimeReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ requireLoaded: true })]),
    );
    expect(stoppedRuntimeReads.every((opts) => opts?.requireLoaded === true)).toBe(true);
  });
});
