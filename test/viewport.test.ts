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
  id = "session-1";
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
  incarnation = "100:$1:%1:1700000000";
  ansiContinuous = false;
  onNextCapture: (() => void) | undefined;
  onEveryCapture: (() => void) | undefined;
  onCapture: ((captureNumber: number) => void) | undefined;
  captureCount = 0;

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
        this.captureCount += 1;
        this.onCapture?.(this.captureCount);
        if (this.onNextCapture !== undefined) {
          const callback = this.onNextCapture;
          this.onNextCapture = undefined;
          callback();
        }
        this.onEveryCapture?.();
        return this.capture(args);
      default:
        return "";
    }
  }

  private sessionLine(): string {
    return (
      [
        this.id,
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
        this.incarnation,
      ].join("|") + "\n"
    );
  }

  private capture(args: readonly string[]): string {
    const start = Number(argumentAfter(args, "-S"));
    const end = Number(argumentAfter(args, "-E"));
    const allRows = [...this.history, ...this.screen];
    const first = start + this.history.length;
    const last = end + this.history.length;
    const rows = allRows.slice(
      Math.max(first, 0),
      Math.min(last + 1, allRows.length),
    );
    if (args.includes("-e") && this.ansiContinuous) {
      return (
        rows
          .map((row, index) => (index === 0 ? `\u001b[31m${row}` : row))
          .join("\n") + "\u001b[0m\n"
      );
    }
    return (
      rows.map((row) => (args.includes("-e") ? ansiRow(row) : row)).join("\n") +
      "\n"
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

test("default viewport rows follow screen growth during capture retry", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.screen = ["short-1", "short-2"];
  tmux.onNextCapture = () => {
    tmux.screen = ["grown-1", "grown-2", "grown-3", "grown-4"];
  };
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const view = await core.viewport("session-1");

  assert.equal(view.screenRows, 4);
  assert.equal(view.viewportRows, 4);
  assert.equal(view.content, "grown-1\ngrown-2\ngrown-3\ngrown-4\n");
});

test("explicit viewport rows do not expand with the screen", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.screen = ["short-1", "short-2"];
  tmux.onNextCapture = () => {
    tmux.screen = ["grown-1", "grown-2", "grown-3", "grown-4"];
  };
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const view = await core.viewport("session-1", { rows: 1 });

  assert.equal(view.screenRows, 4);
  assert.equal(view.viewportRows, 1);
  assert.equal(view.content, "grown-1\n");
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

test("an emitted cursor remains valid for a long session id", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.id = "s".repeat(3_000);
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const view = await core.viewport(tmux.id);
  assert(view.cursor.length > 4_096);

  const restored = await core.viewport(tmux.id, {
    target: { kind: "cursor", cursor: view.cursor },
  });
  assert.equal(restored.content, view.content);
  assert.equal(restored.rebased, false);
});

test("a cursor rebases when the same session id has a new incarnation", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const oldView = await core.viewport("session-1");

  tmux.incarnation = "200:$1:%1:1700000001";
  tmux.history = [
    "new-history-1",
    "new-history-2",
    "new-history-3",
    "new-history-4",
  ];
  tmux.screen = [
    "new-screen-1",
    "new-screen-2",
    "new-screen-3",
    "new-screen-4",
  ];
  const rebased = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: oldView.cursor },
  });

  assert.equal(rebased.live, true);
  assert.equal(rebased.rebased, true);
  assert.match(rebased.content, /^new-screen-1\n/);

  const roundTrip = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: rebased.cursor },
  });
  assert.equal(roundTrip.content, rebased.content);
  assert.equal(roundTrip.rebased, false);
});

test("pure append below history limit preserves its anchor without rebasing", async () => {
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

  assert.equal(restored.rebased, false);
  assert.match(restored.content, /^history-3\n/);
});

test("pure append during final capture retry preserves anchor without rebasing", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  const mutateAtCapture = tmux.captureCount + 2;
  tmux.onCapture = (captureNumber) => {
    if (captureNumber === mutateAtCapture) {
      tmux.history.push("history-5");
      tmux.historyBytes += 100;
    }
  };

  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.match(view.content, /^history-3\n/);
  assert.match(restored.content, /^history-3\n/);
  assert.equal(restored.rebased, false);
  assert.equal(restored.clamped, false);
});

test("cursor scroll retry preserves source anchor across pure append", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  const mutateAtCapture = tmux.captureCount + 2;
  tmux.onCapture = (captureNumber) => {
    if (captureNumber === mutateAtCapture) {
      tmux.history.push("history-5");
      tmux.historyBytes += 100;
    }
  };

  const result = await core.scroll("session-1", {
    cursor: view.cursor,
    direction: "up",
    lines: 1,
  });

  assert.equal(result.kind, "viewport");
  assert.match(result.viewport.content, /^history-2\n/);
  assert.equal(result.viewport.rebased, false);
});

test("net-positive growth at history limit deterministically rebases", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.historyLimit = 100;
  tmux.history = Array.from({ length: 50 }, (_, index) => `old-${index + 1}`);
  tmux.historyBytes = 500;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  assert.match(view.content, /^old-26\n/);

  tmux.onNextCapture = () => {
    const appended = Array.from(
      { length: 75 },
      (_, index) => `new-${index + 1}`,
    );
    tmux.history = [...tmux.history, ...appended].slice(-tmux.historyLimit);
    tmux.historyBytes = 1_000;
  };
  const rebased = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(rebased.historyRows, 100);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.clamped, false);
  assert.match(rebased.content, /^new-26\n/);
  assert.doesNotMatch(rebased.content, /^new-1\n/);

  const roundTrip = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: rebased.cursor },
  });
  assert.equal(roundTrip.content, rebased.content);
  assert.equal(roundTrip.rebased, false);
  assert.equal(roundTrip.clamped, false);
});

test("limit-crossing rebase does not trust repeated blank fingerprints", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.historyLimit = 100;
  tmux.history = Array.from({ length: 50 }, () => "");
  tmux.historyBytes = 50;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });

  tmux.onNextCapture = () => {
    tmux.history = [
      ...tmux.history,
      ...Array.from({ length: 75 }, () => ""),
    ].slice(-tmux.historyLimit);
    tmux.historyBytes = 100;
  };
  const rebased = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(rebased.rebased, true);
  const roundTrip = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: rebased.cursor },
  });
  assert.equal(roundTrip.content, rebased.content);
  assert.equal(roundTrip.rebased, false);
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

test("cursor viewport rows clamp after a pane height decrease", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1");

  tmux.screen = ["short-1", "short-2"];
  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(restored.viewportRows, 2);
  assert.equal(restored.screenRows, 2);
  assert.equal(restored.rebased, true);
  await assert.rejects(
    core.viewport("session-1", {
      target: { kind: "cursor", cursor: view.cursor },
      rows: 4,
    }),
    /must not exceed the terminal screen rows/,
  );
});

test("viewport retries when output changes between facts and capture", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  tmux.onNextCapture = () => {
    tmux.history.push("history-5");
    tmux.historyBytes += 100;
  };

  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  assert.equal(
    tmux.calls.filter((call) => call[0] === "capture-pane").length,
    2,
  );
  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.match(view.content, /^history-3\n/);
  assert.equal(view.historyRows, 5);
  assert.equal(view.rebased, false);
  assert.equal(restored.content, view.content);
  assert.equal(restored.rebased, false);
  assert.equal(
    tmux.calls.filter((call) => call[0] === "capture-pane").length,
    4,
  );
});

test("cursor restore reports a rebase detected during capture retry", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1");
  tmux.onNextCapture = () => {
    tmux.screen = ["resized-1", "resized-2"];
  };

  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(restored.viewportRows, 2);
  assert.equal(restored.screenRows, 2);
  assert.equal(restored.rebased, true);
  assert.equal(restored.content, "resized-1\nresized-2\n");
});

test("viewport fails instead of returning an exhausted unstable snapshot", async () => {
  const tmux = new FakeTerminalTmux();
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  tmux.onEveryCapture = () => {
    tmux.history.push(`busy-${tmux.history.length}`);
    tmux.historyBytes += 10;
  };

  await assert.rejects(
    core.viewport("session-1"),
    /Terminal state did not stabilize/,
  );
  assert.equal(
    tmux.calls.filter((call) => call[0] === "capture-pane").length,
    4,
  );
});

test("full viewport fingerprint detects equal-size eviction after a repeated first row", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.history = ["old", "b", "same", "same"];
  tmux.historyBytes = 100;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  assert.match(view.content, /^same\nsame\n/);

  tmux.history = ["b", "same", "same", "new"];
  const restored = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(restored.rebased, true);
  assert.match(restored.content, /^same\nnew\n/);
});

test("final cursor capture detects equal-size blank-row eviction race", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.history = ["old", "x", "", ""];
  tmux.historyBytes = 100;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  assert.match(view.content, /^\n\n/);

  const mutateAtCapture = tmux.captureCount + 2;
  tmux.onCapture = (captureNumber) => {
    if (captureNumber === mutateAtCapture) {
      tmux.history = ["x", "", "", "new"];
    }
  };
  const rebased = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: view.cursor },
  });

  assert.equal(rebased.historyRows, view.historyRows);
  assert.equal(rebased.rebased, true);
  assert.match(rebased.content, /^\nnew\n/);

  const roundTrip = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: rebased.cursor },
  });
  assert.equal(roundTrip.content, rebased.content);
  assert.equal(roundTrip.rebased, false);
});

test("cursor scroll revalidates source before accepting its destination", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.history = ["old", "x", "", ""];
  tmux.historyBytes = 100;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  const mutateAtCapture = tmux.captureCount + 2;
  tmux.onCapture = (captureNumber) => {
    if (captureNumber === mutateAtCapture) {
      tmux.history = ["x", "", "", "new"];
    }
  };

  const result = await core.scroll("session-1", {
    cursor: view.cursor,
    direction: "up",
    lines: 1,
  });

  assert.equal(result.kind, "viewport");
  assert.equal(result.viewport.rebased, true);
  const roundTrip = await core.viewport("session-1", {
    target: { kind: "cursor", cursor: result.viewport.cursor },
  });
  assert.equal(roundTrip.content, result.viewport.content);
  assert.equal(roundTrip.rebased, false);
});

test("repeated equal-size final capture races fail after retry exhaustion", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.history = ["r0", "r1", "r2", "r3"];
  tmux.historyBytes = 100;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
  });
  let nextRow = 4;
  tmux.onEveryCapture = () => {
    tmux.history = [...tmux.history.slice(1), `r${nextRow}`];
    nextRow += 1;
  };

  await assert.rejects(
    core.viewport("session-1", {
      target: { kind: "cursor", cursor: view.cursor },
    }),
    /Terminal state did not stabilize/,
  );
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

test("classic mouse reports use raw coordinate bytes", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.cols = 120;
  tmux.mouseStandard = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const result = await core.scroll("session-1", {
    direction: "up",
    lines: 1,
    cell: { column: 96, row: 3 },
  });

  assert.deepEqual(result, { kind: "application" });
  assert(
    tmux.calls.some((call) =>
      sameCall(call, [
        "send-keys",
        "-H",
        "-t",
        "session-1",
        "1b",
        "5b",
        "4d",
        "60",
        "80",
        "23",
      ]),
    ),
  );
});

test("large SGR mouse batches are sent in bounded chunks", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.cols = 999;
  tmux.mouseAll = true;
  tmux.mouseSgr = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);

  const result = await core.scroll("session-1", {
    direction: "down",
    lines: 10_000,
    cell: { column: 999, row: 4 },
  });

  assert.deepEqual(result, { kind: "application" });
  const report = "\u001b[<65;999;4M";
  const sends = tmux.calls.filter(
    (call) => call[0] === "send-keys" && call.includes("-l"),
  );
  assert(sends.length > 1);
  assert(
    sends.every((call) => Buffer.byteLength(call.at(-1) ?? "") <= 16 * 1024),
  );
  assert.equal(
    sends.reduce((count, call) => count + (call.at(-1)?.length ?? 0), 0),
    report.length * 10_000,
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

test("ANSI cursor scroll preserves styles that continue across rows", async () => {
  const tmux = new FakeTerminalTmux();
  tmux.ansiContinuous = true;
  const core = new SessionCore({ serverName: "test-server" }, tmux);
  const view = await core.viewport("session-1", {
    target: { kind: "fraction", value: 0.5 },
    rows: 2,
    format: "ansi",
  });

  const result = await core.scroll("session-1", {
    cursor: view.cursor,
    direction: "up",
    lines: 1,
  });

  assert.equal(result.kind, "viewport");
  assert.equal(result.viewport.rebased, false);
  assert(result.viewport.content.startsWith("\u001b[31m"));
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
