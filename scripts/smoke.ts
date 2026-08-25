import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SessionCore, SessionNotFoundError } from "../src/index.js";

const phase = process.argv[2];
const serverName =
  process.argv[3] ?? "tmux-session-core-smoke-" + String(process.pid);
const sessionId = "smoke-session";

if (phase === "create") {
  await createPhase(serverName);
} else if (phase === "rediscover") {
  await rediscoverPhase(serverName);
} else {
  runController("create", serverName);
  runController("rediscover", serverName);
  console.log("smoke flow passed");
}

async function createPhase(server: string): Promise<void> {
  const core = new SessionCore({ serverName: server });
  await core.create({
    id: sessionId,
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    command: "cat",
  });
  assert((await core.list()).some((session) => session.id === sessionId));
  assert.equal((await core.get(sessionId)).id, sessionId);
  await core.input(sessionId, "hello-from-input");
  await waitForScreen(core, "hello-from-input");
  console.log("create/list/get/input/screen passed; controller exiting");
}

async function rediscoverPhase(server: string): Promise<void> {
  const core = new SessionCore({ serverName: server });
  assert((await core.list()).some((session) => session.id === sessionId));
  assert.equal((await core.get(sessionId)).id, sessionId);
  await waitForScreen(core, "hello-from-input");

  await core.stop(sessionId);
  await waitForExit(core);
  const finalScreen = await core.screen(sessionId);
  assert.match(finalScreen, /hello-from-input/);

  await core.delete(sessionId);
  assert(!(await core.list()).some((session) => session.id === sessionId));
  await assert.rejects(core.get(sessionId), SessionNotFoundError);
  console.log("rediscovery/stop/final screen/delete passed");
}

function runController(controllerPhase: string, server: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      controllerPhase,
      server,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, controllerPhase + " controller failed");
}

async function waitForScreen(
  core: SessionCore,
  expected: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const screen = await core.screen(sessionId);
    if (screen.includes(expected)) {
      return screen;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for screen text: " + expected);
}

async function waitForExit(core: SessionCore): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await core.get(sessionId)).exited) {
      return;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for the pane process to exit");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
