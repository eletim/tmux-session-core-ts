import assert from "node:assert/strict";
import test from "node:test";

import { SessionCore, SessionNotFoundError } from "../src/index.js";
import type { TmuxRunner } from "../src/tmux.js";

const SESSION_LINE =
  "session-1|1700000000|0|1234|0||100|30|/work/with%7Cpipe|bash\n";

class FakeTmux implements TmuxRunner {
  readonly calls: string[][] = [];
  outputFor: (args: readonly string[]) => string = () => "";

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return this.outputFor(args);
  }
}

test("list and get derive native facts from tmux output", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = nativeSessionOutput;
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
    cwd: "/work/with|pipe",
    currentCommand: "bash",
  });
  assert.equal(tmux.calls[0]?.[0], "list-sessions");
  assert.equal(tmux.calls.length, 1);
});

test("list reads native facts for multiple sessions with one tmux call", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = () =>
    SESSION_LINE +
    "session-2|1700000001|0|5678|0||80|24|/other%7C%0Acwd%25|node\n";
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const sessions = await core.list();

  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]?.cwd, "/other|\ncwd%");
  assert.equal(sessions[1]?.currentCommand, "node");
  assert.equal(tmux.calls.length, 1);
});

test("get rejects a session absent from tmux", async () => {
  const core = new SessionCore({ serverName: "test-server" }, new FakeTmux());

  await assert.rejects(core.get("missing"), SessionNotFoundError);
});

test("input can write raw terminal bytes without appending Enter", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = nativeSessionOutput;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  await core.input("session-1", "\u001b[A", { submit: false });

  assert(
    tmux.calls.some((call) =>
      isSameCall(call, [
        "send-keys",
        "-t",
        "session-1",
        "-l",
        "--",
        "\u001b[A",
      ]),
    ),
  );
  assert.equal(tmux.calls.filter((call) => call.at(-1) === "Enter").length, 0);
});

test("an exited pane may have no exit status yet", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = (args) => {
    if (args[0] === "list-sessions") {
      return "session-1|1700000000|0|1234|1||80|24|/work|bash\n";
    }
    return nativeSessionOutput(args);
  };
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const session = await core.get("session-1");

  assert.equal(session.exited, true);
  assert.equal(session.exitCode, null);
});

test("create configures remain-on-exit before creating a detached session", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = (args) => {
    if (args[0] === "list-sessions") {
      return SESSION_LINE.replace("session-1", "new-session");
    }
    return nativeSessionOutput(args);
  };
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

test("metadata uses namespaced session user options", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = metadataOutput;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  await core.setMetadata("session-1", "title", "日本語 🌏");
  assert(
    tmux.calls.some((call) =>
      isSameCall(call, [
        "set-option",
        "-t",
        "session-1",
        "@tmux_session_core_title",
        "日本語 🌏",
      ]),
    ),
  );

  assert.equal(await core.getMetadata("session-1", "empty"), "");
  assert.equal(await core.getMetadata("session-1", "unicode"), "日本語 🌏");
  assert.equal(await core.getMetadata("session-1", "missing"), undefined);

  assert.deepEqual(await core.listMetadata("session-1"), {
    empty: "",
    unicode: "日本語 🌏",
  });

  await core.deleteMetadata("session-1", "unicode");
  assert(
    tmux.calls.some((call) =>
      isSameCall(call, [
        "set-option",
        "-u",
        "-t",
        "session-1",
        "@tmux_session_core_unicode",
      ]),
    ),
  );
});

test("invalid metadata keys are rejected before calling tmux", async () => {
  const invalidKeys = ["", "_private", "has space", "has.dot", "日本語"];

  for (const key of invalidKeys) {
    const tmux = new FakeTmux();
    const core = new SessionCore({ serverName: "test-server" }, tmux);
    await assert.rejects(
      core.setMetadata("session-1", key, "value"),
      TypeError,
    );
    assert.equal(tmux.calls.length, 0);
  }
});

test("stop and delete use distinct tmux operations", async () => {
  const tmux = new FakeTmux();
  tmux.outputFor = nativeSessionOutput;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  await core.stop("session-1");
  await core.delete("session-1");

  assert(
    tmux.calls.some((call) => call[0] === "send-keys" && call[3] === "C-c"),
  );
  assert(tmux.calls.some((call) => call[0] === "kill-session"));
});

function nativeSessionOutput(args: readonly string[]): string {
  if (args[0] === "list-sessions") {
    return SESSION_LINE;
  }
  return "";
}

function metadataOutput(args: readonly string[]): string {
  const nativeOutput = nativeSessionOutput(args);
  if (nativeOutput.length > 0) {
    return nativeOutput;
  }
  if (isSameCall(args, ["show-options", "-t", "session-1"])) {
    return [
      "@unrelated keep",
      "@tmux_session_core_bad.key ignored",
      '@tmux_session_core_empty ""',
      '@tmux_session_core_unicode "日本語 🌏"',
      "status on",
      "",
    ].join("\n");
  }
  if (args.at(-1) === "@tmux_session_core_empty") {
    return "\n";
  }
  if (args.at(-1) === "@tmux_session_core_unicode") {
    return "日本語 🌏\n";
  }
  return "";
}

function isSameCall(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
