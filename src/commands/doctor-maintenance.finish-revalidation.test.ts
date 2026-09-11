/** Regression: Doctor completion must reuse the identity-bearing service inspection.
 *
 * OpenClaw #145070: on Linux with a lingering systemd --user gateway,
 * `doctor --fix` stops the gateway and then always fails final revalidation
 * with "Gateway service ownership or manager identity changed", leaving the
 * unit stopped. Root cause: beginDoctorMaintenance().finish() reads post-stop
 * state with `requireEffective` but omits `requireLoadedCommand`, so the
 * runtime reader takes the ordinary `systemctl show` path which carries no
 * managerUid. Linux revalidation then rejects the verdict before restart.
 *
 * The sibling update-restart path (prepareUpdateRestart) already requests
 * both options before invoking the same revalidation owner.
 *
 * Both stopped-unit states the maintainer review calls out are covered:
 * - retained/loaded: identity-bearing read observes the same manager UID, so
 *   revalidation passes and Doctor restarts the unchanged service;
 * - unloaded/not retained: the loaded-unit reader cannot observe the unit, so
 *   revalidation still fails closed with the ownership error instead of
 *   restarting blindly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const mocks = vi.hoisted(() => ({
  resolveService: vi.fn<() => GatewayService>(),
  coordinatorRuntimeDir: "",
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: (...args: []) => mocks.resolveService(...args),
}));

vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: vi.fn(async () => ({ healthy: true })),
}));

// Coordinator lock files default to a host runtime directory ("/tmp" on the
// mocked linux platform). Pin them into the isolated test workspace instead.
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/state-database-coordinator.js")>();
  const withIsolatedRuntimeDir = <T extends { runtimeDirectory?: string }>(params: T): T => ({
    ...params,
    runtimeDirectory: mocks.coordinatorRuntimeDir || params.runtimeDirectory,
  });
  return {
    ...actual,
    acquireGatewayLifecycleCoordinator: (
      params: Parameters<typeof actual.acquireGatewayLifecycleCoordinator>[0],
    ) => actual.acquireGatewayLifecycleCoordinator(withIsolatedRuntimeDir(params)),
    acquireStateDatabaseCoordinator: (
      params: Parameters<typeof actual.acquireStateDatabaseCoordinator>[0],
    ) => actual.acquireStateDatabaseCoordinator(withIsolatedRuntimeDir(params)),
  };
});

// The suite mocks process.platform as linux while executing on a Windows
// host, where POSIX private-mode bits do not apply. Keep real SQLite locking
// but skip the mode check itself (covered by state-database-coordinator.test.ts).
vi.mock("../infra/sqlite-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-coordinator.js")>();
  const nodeFs = await import("node:fs");
  return {
    ...actual,
    ensurePrivateSqliteCoordinatorDirectory: (directoryPath: string) => {
      nodeFs.mkdirSync(directoryPath, { recursive: true });
    },
  };
});

beforeEach(() => mockSystemAccountHome());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type StoppedUnitState = "retained" | "unloaded";

async function runDoctorFinishForStoppedUnit(scenario: StoppedUnitState): Promise<{
  finishError: unknown;
  restartCalls: number;
  finishPhaseRuntimeReads: Array<{ requireLoaded: boolean }>;
  logs: string[];
}> {
  const home = await makeTempWorkspace("openclaw-doctor-finish-145070-");
  mocks.coordinatorRuntimeDir = home;
  try {
    return await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
      },
      async () => {
        mockProcessPlatform("linux");
        let running = true;
        const finishPhaseRuntimeReads: Array<{ requireLoaded: boolean }> = [];
        let stopObserved = false;
        const command = {
          programArguments: [
            process.execPath,
            path.join(process.cwd(), "openclaw.mjs"),
            "gateway",
            "--port",
            "18789",
          ],
          environment: { HOME: home },
        };
        const restart = vi.fn(async () => {
          running = true;
          return { outcome: "completed" as const };
        });
        mocks.resolveService.mockReturnValue(
          createMockGatewayService({
            isAbsent: async () => false,
            hasInstalledDefinition: async () => true,
            isLoaded: async () => scenario === "retained",
            readCommand: async () => ({
              programArguments: [...command.programArguments],
              environment: { ...command.environment },
            }),
            readRuntime: async (_env, opts) => {
              if (stopObserved) {
                finishPhaseRuntimeReads.push({ requireLoaded: opts?.requireLoaded === true });
              }
              if (running) {
                return { status: "running", systemd: { managerUid: 2001 } };
              }
              if (scenario === "retained") {
                // Ordinary `systemctl show` carries no manager identity; only the
                // loaded-unit (D-Bus) reader observes the manager UID.
                return opts?.requireLoaded === true
                  ? {
                      status: "stopped",
                      systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
                    }
                  : { status: "stopped" };
              }
              // systemd unloaded the stopped unit: GetUnit cannot observe it.
              return { status: "unknown" };
            },
            stop: vi.fn(async () => {
              running = false;
              stopObserved = true;
            }),
            restart,
          }),
        );
        const logs: string[] = [];
        const maintenance = await beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true },
          runtime: {
            log: (...args: Array<unknown>) => {
              logs.push(args.map((entry) => String(entry)).join(" "));
            },
            error: () => {},
            exit: () => {},
          },
        });
        expect(maintenance).toBeDefined();
        let finishError: unknown;
        try {
          await maintenance?.finish({} as OpenClawConfig);
        } catch (error) {
          finishError = error;
        }
        return {
          finishError,
          restartCalls: restart.mock.calls.length,
          finishPhaseRuntimeReads,
          logs,
        };
      },
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

it("restarts the unchanged gateway when the stopped unit stays loaded", async () => {
  const { finishError, restartCalls, finishPhaseRuntimeReads, logs } =
    await runDoctorFinishForStoppedUnit("retained");
  expect(finishError).toBeUndefined();
  expect(restartCalls).toBe(1);
  expect(finishPhaseRuntimeReads.length).toBeGreaterThan(0);
  expect(finishPhaseRuntimeReads.some((read) => read.requireLoaded)).toBe(true);
  expect(logs.join("\n")).toContain("Gateway restarted and verified after Doctor repair.");
});

it("fails closed when systemd unloaded the stopped unit", async () => {
  const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit("unloaded");
  expect(finishError).toMatchObject({
    message: expect.stringMatching(/ownership or manager identity changed/),
  });
  expect(restartCalls).toBe(0);
});
