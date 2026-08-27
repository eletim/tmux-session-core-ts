import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionCore,
  type ViewportCursor,
  type ViewportFormat,
} from "../src/index.js";
import type { TmuxRunner } from "../src/tmux.js";

class FakeTerminalTmux implements TmuxRunner {
  readonly calls: string[][] = [];
  history = ["history-1", "history-2", "history-3", "history-4"];
  screen = ["screen-1", "screen-2", "screen-3", "screen-4"];
  cols = 80;
  historyLimit = 100;
  historyBytes = 400;
  dead = false;
  alternate = false;
  mouseStandard = false;
  mouseButton = false;
  mouseAll = false;
  mouseUtf8 = false;
  mouseSgr = false;

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    switch (args[0]) {
      case "list-sessions":
        return this.sessionLine();
      case "display-message":
        return this.factsLine();
      case "capture-pane":
        if (args.includes("-J")) {
          return "legacy-history-and-screen\n";
        }
        return this.capture(args);
      default:
        return "";
    }
  }

  private sessionLine(): string {
    return (
      [
        "session-1",
        "1700000000",
        "0",
        "1234",
        this.dead ? "1" : "0",
        this.dead ? "0" : "",
        String(this.cols),
        String(this.screen.length),
        "/work",
        "bash",
      ].join("|") + "\n"
    );
  }

  private factsLine(): string {
    return (
      [
        this.history.length,
        this.historyLimit,
        this.historyBytes,
        this.cols,
        this.screen.length,
        Number(this.dead),
        Number(this.alternate),
        Number(this.mouseStandard),
        Number(this.mouseButton),
        Number(this.mouseAll),
        Number(this.mouseUtf8),
        Number(this.mouseSgr),
      ].join("|") + "\n"
    );
  }

  private capture(args: readonly string[]): string {
    const start = Number(argumentAfter(args, "-S"));
    const end = Number(argumentAfter(args, "-E"));
    const allRows = [...this.history, ...this.screen];
    const first = start + this.history.length;
    const last = end + this.history.length;
    return (
      allRows
        .slice(Math.max(first, 0), Math.min(last + 1, allRows.length))
        .map((row) => (args.includes("-e") ? ansiRow(row) : row))
        .join("\n") + "\n"
    );
  }
}

test("legacy screen keeps the full joined capture contract", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  assert.equal(await core.screen("session-1"), "legacy-history-and-screen\n");
  assert(
    tmux.calls.some((call) =>
      sameCall(call, [
        "capture-pane",
        "-p",
        "-J",
        "-S",
        "-",
        "-t",
        "session-1",
      ]),
    ),
  );
});

test("live viewport captures physical screen rows without joining wraps", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const view = await core.viewport("session-1");

  assert.equal(view.content, "screen-1\nscreen-2\nscreen-3\nscreen-4\n");
  assert.equal(view.live, true);
  assert.equal(view.viewportRows, 4);
  assert.equal(view.historyRows, 4);
  const capture = tmux.calls.find((call) => call[0] === "capture-pane");
  assert(capture);
  assert(!capture.includes("-J"));
  assert.equal(argumentAfter(capture, "-S"), "0");
  assert.equal(argumentAfter(capture, "-E"), "3");
});

test("cursor scrolling and fraction seeking use independent positions", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const live = await core.viewport("session-1");

  const viewerA = await core.scroll("session-1", {
    cursor: live.cursor,
    direction: "up",
    lines: 2,
  });
  const viewerB = await core.scroll("session-1", {
    cursor: live.cursor,
    direction: "up",
    lines: 4,
  });
  assert.equal(viewerA.kind, "viewport");
  assert.equal(viewerB.kind, "viewport");
  assert.match(viewerA.viewport.content, /^history-3\n/);
  assert.match(viewerB.viewport.content, /^history-1\n/);

  const movedA = await core.scroll("session-1", {
    cursor: viewerA.viewport.cursor,
    direction: "down",
    lines: 1,
  });
  assert.equal(movedA.kind, "viewport");
  assert.match(movedA.viewport.content, /^history-4\n/);
  assert.match(viewerB.viewport.content, /^history-1\n/);

  const middle = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  assert.match(middle.content, /^history-3\n/);
  const oldest = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0 },
  });
  assert.match(oldest.content, /^history-1\n/);
});

test("history growth rebases an old cursor while preserving its first row", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });

  tmux.history.push("history-5", "history-6");
  tmux.historyBytes += 200;
  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(restored.rebased, true);
  assert.match(restored.content, /^history-3\n/);
});

test("history eviction and resize are detected and deterministically rebased", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const oldest = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0 },
  });

  tmux.history = ["history-3", "history-4", "history-5", "history-6"];
  tmux.historyBytes += 1;
  const evicted = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: oldest.cursor },
  });
  assert.equal(evicted.rebased, true);
  assert.match(evicted.content, /^history-3\n/);

  tmux.cols = 120;
  tmux.history = ["wide-1", "wide-2"];
  tmux.historyBytes = 200;
  const resized = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: evicted.cursor },
  });
  assert.equal(resized.rebased, true);
  assert.match(resized.content, /^wide-1\n/);
});

test("mouse-owning applications receive internal SGR wheel input", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.mouseAll = true;
  tmux.mouseSgr = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const result = await core.scroll("session-1", {
    direction: "up",
    lines: 2,
    cell: { column: 7, row: 3 },
  });

  assert.deepEqual(result, { kind: "application" });
  assert(
    tmux.calls.some((call) =>
      sameCall(call, [
        "send-keys",
        "-t",
        "session-1",
        "-l",
        "--",
        "\u001b[<64;7;3M\u001b[<64;7;3M",
      ]),
    ),
  );
});

test("alternate screen without mouse ownership uses alternate-scroll keys", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.alternate = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const result = await core.scroll("session-1", {
    direction: "down",
    lines: 3,
  });

  assert.deepEqual(result, { kind: "application" });
  assert(
    tmux.calls.some((call) =>
      sameCall(call, ["send-keys", "-N", "3", "-t", "session-1", "Down"]),
    ),
  );
});

test("dead panes navigate inspectable history and receive no application input", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.dead = true;
  tmux.alternate = true;
  tmux.mouseAll = true;
  tmux.mouseSgr = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const result = await core.scroll("session-1", {
    direction: "up",
    lines: 2,
  });

  assert.equal(result.kind, "viewport");
  assert.match(result.viewport.content, /^history-3\n/);
  assert(!tmux.calls.some((call) => call[0] === "send-keys"));
});

test("ANSI viewport requests styled physical rows", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const view = await core.viewport("session-1", { format: "ansi", rows: 2 });

  assert(view.content.includes("\u001b[31mscreen-1\u001b[0m"));
  const capture = tmux.calls.find((call) => call[0] === "capture-pane");
  assert(capture?.includes("-e"));
  assert(!capture?.includes("-J"));
});

test("invalid viewport requests fail before capture or input", async () => {
  const invalidCursors = [
    "not+base64",
    Buffer.from("{}", "utf8").toString("base64url"),
  ];

  for (const cursor of invalidCursors) {
    const tmux = new FakeTerminalTmux();
    const core = new SessionCore({ serverName: "test-server" }, tmux);
    await assert.rejects(
      core.viewport("session-1", {
        target: {
          kind: "cursor",
          cursor: cursor as ViewportCursor,
        },
      }),
      /Invalid viewport cursor/,
    );
    assert(!tmux.calls.some((call) => call[0] === "capture-pane"));
  }

  const invalidRows = [0, -1, 1.5, 5];
  for (const rows of invalidRows) {
    const tmux = new FakeTerminalTmux();
    const core = new SessionCore({ serverName: "test-server" }, tmux);
    await assert.rejects(core.viewport("session-1", { rows }), TypeError);
  }

  for (const value of [-0.1, 1.1, Number.NaN]) {
    const core = new SessionCore(
      { serverName: "test-server" },
      new FakeTerminalTmux(),
    );
    await assert.rejects(
      core.viewport("session-1", {
        target: { kind: "fraction", value },
      }),
      TypeError,
    );
  }

  const invalidFormat = "html" as ViewportFormat;
  const core = new SessionCore(
    { serverName: "test-server" },
    new FakeTerminalTmux(),
  );
  await assert.rejects(
    core.viewport("session-1", { format: invalidFormat }),
    TypeError,
  );
  await assert.rejects(
    core.scroll("session-1", { direction: "up", lines: 0 }),
    TypeError,
  );
});

function ansiRow(row: string): string {
  return `\u001b[31m${row}\u001b[0m`;
}

function argumentAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  assert.notEqual(index, -1);
  assert(value !== undefined);
  return value;
}

function sameCall(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
