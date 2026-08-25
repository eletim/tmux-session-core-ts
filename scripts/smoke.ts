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
  const created = await waitForCommand(core, "cat");
  assert.equal(created.cwd, process.cwd());

  await core.setMetadata(sessionId, "kind", "generic-client");
  await core.setMetadata(sessionId, "title", "再発見テスト 🌏");
  await core.setMetadata(sessionId, "empty", "");
  setUnrelatedOption(server);

  assert.equal(await core.getMetadata(sessionId, "kind"), "generic-client");
  assert.equal(await core.getMetadata(sessionId, "title"), "再発見テスト 🌏");
  assert.equal(await core.getMetadata(sessionId, "empty"), "");
  await core.input(sessionId, "hello-from-input");
  await waitForScreen(core, "hello-from-input");
  console.log(
    "create/native facts/metadata/input/screen passed; controller exiting",
  );
}

async function rediscoverPhase(server: string): Promise<void> {
  const core = new SessionCore({ serverName: server });
  const rediscovered = (await core.list()).find(
    (session) => session.id === sessionId,
  );
  assert(rediscovered);
  assert.equal(rediscovered.cwd, process.cwd());
  assert.equal(rediscovered.currentCommand, "cat");
  assert.deepEqual(await core.listMetadata(sessionId), {
    empty: "",
    kind: "generic-client",
    title: "再発見テスト 🌏",
  });
  assert.equal(await core.getMetadata(sessionId, "title"), "再発見テスト 🌏");
  assert(!("cwd" in (await core.listMetadata(sessionId))));
  assert(!("currentCommand" in (await core.listMetadata(sessionId))));
  await waitForScreen(core, "hello-from-input");

  await core.setMetadata(sessionId, "title", "updated");
  await core.deleteMetadata(sessionId, "empty");
  assert.deepEqual(await core.listMetadata(sessionId), {
    kind: "generic-client",
    title: "updated",
  });

  await core.stop(sessionId);
  await waitForExit(core);
  const finalScreen = await core.screen(sessionId);
  assert.match(finalScreen, /hello-from-input/);

  await core.delete(sessionId);
  assert(!(await core.list()).some((session) => session.id === sessionId));
  await assert.rejects(core.get(sessionId), SessionNotFoundError);
  await assert.rejects(core.listMetadata(sessionId), SessionNotFoundError);
  console.log(
    "rediscovery/metadata update-delete/stop/final screen/session delete passed",
  );
}

function setUnrelatedOption(server: string): void {
  const result = spawnSync(
    "tmux",
    [
      "-L",
      server,
      "set-option",
      "-t",
      sessionId,
      "@unrelated_smoke_option",
      "must-not-be-listed",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  assert.equal(result.status, 0, result.stderr);
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

async function waitForCommand(
  core: SessionCore,
  expected: string,
): Promise<Awaited<ReturnType<SessionCore["get"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = await core.get(sessionId);
    if (session.currentCommand === expected) {
      return session;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for current command: " + expected);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
