import assert from "node:assert/strict";
import test from "node:test";

import { SessionCore, SessionNotFoundError } from "../src/index.js";
import type { TmuxRunner } from "../src/tmux.js";

class FakeTmux implements TmuxRunner {
  readonly calls: string[][] = [];
  output = "";

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return this.output;
  }
}

test("list and get derive session state from tmux output", async () => {
  const tmux = new FakeTmux();
  tmux.output = "session-1|1700000000|0|1234|0||100|30\n";
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const session = await core.get("session-1");

  assert.deepEqual(session, {
    id: "session-1",
    createdAt: new Date(1_700_000_000_000),
    attached: false,
    processId: 1234,
    exited: false,
    exitCode: null,
    cols: 100,
    rows: 30,
  });
  assert.equal(tmux.calls[0]?.[0], "list-sessions");
});

test("get rejects a session absent from tmux", async () => {
  const core = new SessionCore({ serverName: "test-server" }, new FakeTmux());

  await assert.rejects(core.get("missing"), SessionNotFoundError);
});

test("an exited pane may have no exit status yet", async () => {
  const tmux = new FakeTmux();
  tmux.output = "session-1|1700000000|0|1234|1||80|24\n";
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const session = await core.get("session-1");

  assert.equal(session.exited, true);
  assert.equal(session.exitCode, null);
});

test("create configures remain-on-exit before creating a detached session", async () => {
  const tmux = new FakeTmux();
  tmux.output = "new-session|1700000000|0|1234|0||80|24\n";
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  await core.create({
    id: "new-session",
    cwd: "/tmp",
    command: "printf ready",
  });

  assert.deepEqual(tmux.calls[0], [
    "set-option",
    "-g",
    "remain-on-exit",
    "on",
    ";",
    "new-session",
    "-d",
    "-s",
    "new-session",
    "-c",
    "/tmp",
    "printf ready",
  ]);
});

test("stop and delete use distinct tmux operations", async () => {
  const tmux = new FakeTmux();
  tmux.output = "session-1|1700000000|0|1234|0||80|24\n";
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  await core.stop("session-1");
  await core.delete("session-1");

  assert(
    tmux.calls.some((call) => call[0] === "send-keys" && call[3] === "C-c"),
  );
  assert(tmux.calls.some((call) => call[0] === "kill-session"));
});
