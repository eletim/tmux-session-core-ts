import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { SessionCore } from "../src/index.js";

const execFileAsync = promisify(execFile);
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test(
  "real tmux provides stateless physical-row viewport and scroll semantics",
  { skip: hasTmux ? false : "tmux is not installed" },
  async (t) => {
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const server = `viewport-integration-${suffix}`;
    const scratch = await mkdtemp(join(tmpdir(), "viewport-integration-"));
    const core = new SessionCore({ serverName: server });

    t.after(async () => {
      await runTmux(server, ["kill-server"], true);
      await rm(scratch, { recursive: true, force: true });
    });

    await t.test(
      "normal history, cursor navigation, viewers, and copy-mode",
      async () => {
        await core.create({
          id: "normal",
          cwd: process.cwd(),
          cols: 20,
          rows: 5,
          command: "bash --noprofile --norc",
        });
        await core.input("normal", "seq 1 80");
        await waitForFormat(
          server,
          "normal",
          "#{history_size}",
          (value) => Number(value) >= 70,
        );

        const legacy = await core.screen("normal");
        assert.match(legacy, /80/);

        const live = await core.viewport("normal");
        assert.equal(live.live, true);
        assert.equal(live.viewportRows, 5);
        assert.match(live.content, /80/);

        const viewerA = await core.scroll("normal", {
          cursor: live.cursor,
          direction: "up",
          lines: 5,
        });
        const viewerB = await core.scroll("normal", {
          cursor: live.cursor,
          direction: "up",
          lines: 12,
        });
        assert.equal(viewerA.kind, "viewport");
        assert.equal(viewerB.kind, "viewport");
        assert.notEqual(viewerA.viewport.content, viewerB.viewport.content);

        const down = await core.scroll("normal", {
          cursor: viewerA.viewport.cursor,
          direction: "down",
          lines: 2,
        });
        assert.equal(down.kind, "viewport");
        assert.notEqual(down.viewport.content, viewerA.viewport.content);
        assert.equal(viewerB.viewport.live, false);

        const oldest = await core.viewport("normal", {
          target: { kind: "fraction", value: 0 },
        });
        const middle = await core.viewport("normal", {
          target: { kind: "fraction", value: 0.5 },
        });
        assert.equal(oldest.live, false);
        assert.notEqual(oldest.content, middle.content);

        await runTmux(server, ["copy-mode", "-t", "normal"]);
        await runTmux(server, [
          "send-keys",
          "-X",
          "-t",
          "normal",
          "-N",
          "8",
          "scroll-up",
        ]);
        const modeBefore = await tmuxOutput(server, [
          "display-message",
          "-p",
          "-t",
          "normal",
          "#{pane_in_mode}|#{scroll_position}",
        ]);
        await core.viewport("normal", {
          target: { kind: "fraction", value: 0.25 },
        });
        const modeAfter = await tmuxOutput(server, [
          "display-message",
          "-p",
          "-t",
          "normal",
          "#{pane_in_mode}|#{scroll_position}",
        ]);
        assert.equal(modeAfter, modeBefore);
        assert.match(modeAfter, /^1\|8\s*$/);
        await runTmux(server, ["send-keys", "-X", "-t", "normal", "cancel"]);

        const restartedCore = new SessionCore({ serverName: server });
        const restored = await restartedCore.viewport("normal", {
          target: { kind: "cursor", cursor: viewerB.viewport.cursor },
        });
        assert.equal(restored.content, viewerB.viewport.content);
        assert.equal(restored.rebased, false);
      },
    );

    await t.test("wrapped output remains physical rows", async () => {
      await core.create({
        id: "wrapped",
        cwd: process.cwd(),
        cols: 10,
        rows: 4,
        command: "sh -c 'printf abcdefghijklmnopqrstuvwxyz; exec sleep 30'",
      });
      await waitForScreen(core, "wrapped", "uvwxyz");
      const view = await core.viewport("wrapped");
      const rows = view.content.split("\n").slice(0, -1);
      assert.equal(rows.length, 4);
      assert(!view.content.includes("abcdefghijklmnopqrstuvwxyz"));
      assert(rows.some((row) => row.includes("abcdefghij")));
      assert(rows.some((row) => row.includes("klmnopqrst")));
    });

    await t.test("history eviction clamps and rebases cursors", async () => {
      await runTmux(server, ["set-option", "-g", "history-limit", "20"]);
      await core.create({
        id: "limited",
        cwd: process.cwd(),
        cols: 20,
        rows: 5,
        command: "bash --noprofile --norc",
      });
      await core.input("limited", "seq 1 100");
      await waitForScreen(core, "limited", "100");
      const oldest = await core.viewport("limited", {
        target: { kind: "fraction", value: 0 },
      });
      assert(oldest.historyRows <= 20);

      const clamped = await core.scroll("limited", {
        cursor: oldest.cursor,
        direction: "up",
        lines: 10_000,
      });
      assert.equal(clamped.kind, "viewport");
      assert.equal(clamped.viewport.clamped, true);

      await core.input("limited", "seq 101 160");
      await waitForScreen(core, "limited", "160");
      const afterEviction = await core.viewport("limited", {
        target: { kind: "cursor", cursor: oldest.cursor },
      });
      assert.equal(afterEviction.rebased, true);
      assert(afterEviction.historyRows <= 20);
    });

    await t.test("ANSI capture preserves styling", async () => {
      await core.create({
        id: "ansi",
        cwd: process.cwd(),
        cols: 20,
        rows: 4,
        command: "sh -c 'printf \"\\033[31mRED\\033[0m\"; exec sleep 30'",
      });
      await waitForScreen(core, "ansi", "RED");
      const plain = await core.viewport("ansi", { format: "plain" });
      const ansi = await core.viewport("ansi", { format: "ansi" });
      assert(!plain.content.includes("\u001b["));
      assert(ansi.content.includes("\u001b[31m"));
      assert.match(ansi.content, /RED/);
    });

    await t.test("mouse tracking receives SGR wheel input", async () => {
      const inputFile = join(scratch, "mouse-input");
      const expected = "\u001b[<64;2;3M";
      await core.create({
        id: "mouse-tui",
        cwd: process.cwd(),
        cols: 20,
        rows: 5,
        command: terminalReaderCommand(
          "\\033[?1049h\\033[?1003h\\033[?1006h",
          inputFile,
          Buffer.byteLength(expected),
        ),
      });
      await waitForFormat(
        server,
        "mouse-tui",
        "#{alternate_on}|#{mouse_all_flag}|#{mouse_sgr_flag}",
        (value) => value.trim() === "1|1|1",
      );

      const result = await core.scroll("mouse-tui", {
        direction: "up",
        lines: 1,
        cell: { column: 2, row: 3 },
      });
      assert.deepEqual(result, { kind: "application" });
      await waitForFileSize(inputFile, Buffer.byteLength(expected));
      assert.equal(await readFile(inputFile, "utf8"), expected);
    });

    await t.test(
      "classic mouse tracking receives raw coordinate bytes",
      async () => {
        const inputFile = join(scratch, "classic-mouse-input");
        const expected = Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0x80, 0x23]);
        await core.create({
          id: "classic-mouse-tui",
          cwd: process.cwd(),
          cols: 120,
          rows: 5,
          command: terminalReaderCommand(
            "\\033[?1049h\\033[?1000h",
            inputFile,
            expected.length,
          ),
        });
        await waitForFormat(
          server,
          "classic-mouse-tui",
          "#{alternate_on}|#{mouse_standard_flag}|#{mouse_sgr_flag}",
          (value) => value.trim() === "1|1|0",
        );

        const result = await core.scroll("classic-mouse-tui", {
          direction: "up",
          lines: 1,
          cell: { column: 96, row: 3 },
        });
        assert.deepEqual(result, { kind: "application" });
        await waitForFileSize(inputFile, expected.length);
        assert.deepEqual(await readFile(inputFile), expected);
      },
    );

    await t.test(
      "alternate screen without mouse uses cursor-key scrolling",
      async () => {
        const inputFile = join(scratch, "alternate-input");
        const expected = "\u001b[A";
        await core.create({
          id: "alternate-tui",
          cwd: process.cwd(),
          cols: 20,
          rows: 5,
          command: terminalReaderCommand(
            "\\033[?1049h",
            inputFile,
            Buffer.byteLength(expected),
          ),
        });
        await waitForFormat(
          server,
          "alternate-tui",
          "#{alternate_on}|#{mouse_any_flag}",
          (value) => value.trim() === "1|0",
        );

        const result = await core.scroll("alternate-tui", {
          direction: "up",
          lines: 1,
        });
        assert.deepEqual(result, { kind: "application" });
        await waitForFileSize(inputFile, Buffer.byteLength(expected));
        assert.equal(await readFile(inputFile, "utf8"), expected);
      },
    );

    await t.test(
      "TUI exit and dead alternate panes remain inspectable",
      async () => {
        await core.create({
          id: "tui-exit",
          cwd: process.cwd(),
          cols: 24,
          rows: 5,
          command:
            "sh -c 'printf NORMAL-BEFORE; printf \"\\033[?1049hALT-LIVE\\033[?1049l\"'",
        });
        await waitForExit(core, "tui-exit");
        const exited = await core.viewport("tui-exit");
        assert.match(exited.content, /NORMAL-BEFORE|Pane is dead/);
        assert(!exited.content.includes("ALT-LIVE"));

        await core.create({
          id: "tui-dead",
          cwd: process.cwd(),
          cols: 24,
          rows: 5,
          command: "sh -c 'printf \"\\033[?1049hALT-DEAD\"; exit 9'",
        });
        await waitForExit(core, "tui-dead");
        const dead = await core.scroll("tui-dead", {
          direction: "up",
          lines: 1,
        });
        assert.equal(dead.kind, "viewport");
        assert.match(dead.viewport.content, /ALT-DEAD|Pane is dead/);
      },
    );

    await t.test("resize and reflow rebase an opaque cursor", async () => {
      await runTmux(server, ["set-option", "-g", "history-limit", "2000"]);
      await core.create({
        id: "resize",
        cwd: process.cwd(),
        cols: 12,
        rows: 5,
        command:
          "sh -c 'i=1; while [ $i -le 30 ]; do printf \"line-%02d-abcdefghijklmnopqrstuvwxyz\\n\" $i; i=$((i+1)); done; exec sleep 30'",
      });
      await waitForFormat(
        server,
        "resize",
        "#{history_size}",
        (value) => Number(value) > 40,
      );
      const before = await core.viewport("resize", {
        target: { kind: "fraction", value: 0.5 },
      });

      await core.resize("resize", 24, 7);
      await waitForFormat(
        server,
        "resize",
        "#{pane_width}x#{pane_height}",
        (value) => value.trim() === "24x7",
      );
      const after = await core.viewport("resize", {
        target: { kind: "cursor", cursor: before.cursor },
      });
      assert.equal(after.rebased, true);
      assert.equal(after.cols, 24);
      assert.equal(after.screenRows, 7);
    });
  },
);

function terminalReaderCommand(
  modes: string,
  outputFile: string,
  bytes: number,
): string {
  return `sh -c 'stty raw -echo; printf "${modes}"; dd bs=1 count=${bytes} of="${outputFile}" 2>/dev/null; exec sleep 30'`;
}

async function waitForScreen(
  core: SessionCore,
  id: string,
  expected: string,
): Promise<void> {
  await waitUntil(async () => (await core.screen(id)).includes(expected));
}

async function waitForExit(core: SessionCore, id: string): Promise<void> {
  await waitUntil(async () => (await core.get(id)).exited);
}

async function waitForFormat(
  server: string,
  id: string,
  format: string,
  predicate: (value: string) => boolean,
): Promise<void> {
  await waitUntil(async () => {
    const value = await tmuxOutput(server, [
      "display-message",
      "-p",
      "-t",
      id,
      format,
    ]);
    return predicate(value);
  });
}

async function waitForFileSize(file: string, size: number): Promise<void> {
  await waitUntil(async () => {
    try {
      return (await stat(file)).size === size;
    } catch {
      return false;
    }
  });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for real tmux state");
}

async function tmuxOutput(server: string, args: string[]): Promise<string> {
  const result = await runTmux(server, args);
  return result.stdout;
}

async function runTmux(
  server: string,
  args: string[],
  ignoreFailure = false,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("tmux", ["-L", server, ...args], {
      encoding: "utf8",
    });
  } catch (error) {
    if (ignoreFailure) {
      return { stdout: "", stderr: "" };
    }
    throw error;
  }
}
