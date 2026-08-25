import { randomUUID } from "node:crypto";

import { TmuxClient, TmuxCommandError, type TmuxRunner } from "./tmux.js";

const DEFAULT_SERVER_NAME = "tmux-session-core-ts";
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_METADATA_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const METADATA_OPTION_PREFIX = "@tmux_session_core_";
const SESSION_FORMAT =
  "#{session_name}|#{session_created}|#{session_attached}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_width}|#{pane_height}";

export interface Session {
  id: string;
  createdAt: Date;
  attached: boolean;
  processId: number;
  exited: boolean;
  exitCode: number | null;
  cols: number;
  rows: number;
  cwd: string;
  currentCommand: string;
}

type SessionSummary = Omit<Session, "cwd" | "currentCommand">;

export interface CreateSessionOptions {
  command: string;
  cwd: string;
  id?: string;
  cols?: number;
  rows?: number;
}

export interface SessionCoreOptions {
  serverName?: string;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionCore {
  readonly serverName: string;
  private readonly tmux: TmuxRunner;

  constructor(options?: SessionCoreOptions);
  /** @internal */
  constructor(options: SessionCoreOptions, tmux: TmuxRunner);
  constructor(options: SessionCoreOptions = {}, tmux?: TmuxRunner) {
    this.serverName = options.serverName ?? DEFAULT_SERVER_NAME;
    assertSafeName(this.serverName, "serverName");
    this.tmux = tmux ?? new TmuxClient(this.serverName);
  }

  async create(options: CreateSessionOptions): Promise<Session> {
    const id = options.id ?? randomUUID();
    assertSafeName(id, "session id");
    if (options.command.length === 0) {
      throw new TypeError("command must not be empty");
    }
    if (options.cwd.length === 0) {
      throw new TypeError("cwd must not be empty");
    }

    const sizeArgs = sizeArguments(options.cols, options.rows);
    await this.tmux.run([
      "set-option",
      "-g",
      "remain-on-exit",
      "on",
      ";",
      "new-session",
      "-d",
      ...sizeArgs,
      "-s",
      id,
      "-c",
      options.cwd,
      options.command,
    ]);

    return this.get(id);
  }

  async list(): Promise<Session[]> {
    let output: string;
    try {
      output = await this.tmux.run(["list-sessions", "-F", SESSION_FORMAT]);
    } catch (error) {
      if (isMissingServer(error)) {
        return [];
      }
      throw error;
    }

    const sessions = output
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseSession);

    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        cwd: await this.readFormat(session.id, "#{pane_current_path}"),
        currentCommand: await this.readFormat(
          session.id,
          "#{pane_current_command}",
        ),
      })),
    );
  }

  async get(id: string): Promise<Session> {
    assertSafeName(id, "session id");
    const session = (await this.list()).find(
      (candidate) => candidate.id === id,
    );
    if (session === undefined) {
      throw new SessionNotFoundError(id);
    }
    return session;
  }

  async screen(id: string): Promise<string> {
    await this.get(id);
    return this.tmux.run(["capture-pane", "-p", "-J", "-S", "-", "-t", id]);
  }

  async input(id: string, text: string): Promise<void> {
    await this.get(id);
    await this.tmux.run(["send-keys", "-t", id, "-l", "--", text]);
    await this.tmux.run(["send-keys", "-t", id, "Enter"]);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.get(id);
    assertDimension(cols, "cols");
    assertDimension(rows, "rows");
    await this.tmux.run([
      "resize-window",
      "-t",
      id,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
  }

  async stop(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session.exited) {
      await this.tmux.run(["send-keys", "-t", id, "C-c"]);
    }
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.tmux.run(["kill-session", "-t", id]);
  }

  async setMetadata(id: string, key: string, value: string): Promise<void> {
    const optionName = metadataOptionName(key);
    await this.get(id);
    await this.tmux.run(["set-option", "-t", id, optionName, value]);
  }

  async getMetadata(id: string, key: string): Promise<string | undefined> {
    const optionName = metadataOptionName(key);
    await this.get(id);
    const optionNames = await this.listManagedOptionNames(id);
    if (!optionNames.includes(optionName)) {
      return undefined;
    }
    return this.readOption(id, optionName);
  }

  async listMetadata(id: string): Promise<Record<string, string>> {
    await this.get(id);
    const optionNames = await this.listManagedOptionNames(id);
    const entries = await Promise.all(
      optionNames.map(
        async (optionName) =>
          [
            optionName.slice(METADATA_OPTION_PREFIX.length),
            await this.readOption(id, optionName),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async deleteMetadata(id: string, key: string): Promise<void> {
    const optionName = metadataOptionName(key);
    await this.get(id);
    await this.tmux.run(["set-option", "-u", "-t", id, optionName]);
  }

  private async readFormat(id: string, format: string): Promise<string> {
    const output = await this.tmux.run([
      "display-message",
      "-p",
      "-t",
      id,
      format,
    ]);
    return removeOutputNewline(output);
  }

  private async listManagedOptionNames(id: string): Promise<string[]> {
    const output = await this.tmux.run(["show-options", "-t", id]);
    return output
      .split("\n")
      .map(optionNameFromLine)
      .filter((name) => {
        const key = name.slice(METADATA_OPTION_PREFIX.length);
        return (
          name.startsWith(METADATA_OPTION_PREFIX) && SAFE_METADATA_KEY.test(key)
        );
      });
  }

  private async readOption(id: string, optionName: string): Promise<string> {
    const output = await this.tmux.run([
      "show-options",
      "-v",
      "-t",
      id,
      optionName,
    ]);
    return removeOutputNewline(output);
  }
}

function sizeArguments(cols?: number, rows?: number): string[] {
  if (cols === undefined && rows === undefined) {
    return [];
  }
  if (cols === undefined || rows === undefined) {
    throw new TypeError("cols and rows must be provided together");
  }
  assertDimension(cols, "cols");
  assertDimension(rows, "rows");
  return ["-x", String(cols), "-y", String(rows)];
}

function assertDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertSafeName(value: string, name: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new TypeError(`${name} may contain only letters, numbers, _ and -`);
  }
}

function metadataOptionName(key: string): string {
  if (!SAFE_METADATA_KEY.test(key)) {
    throw new TypeError(
      "metadata key must start with a letter or number and contain only letters, numbers, _ and -",
    );
  }
  return METADATA_OPTION_PREFIX + key;
}

function removeOutputNewline(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function optionNameFromLine(line: string): string {
  const separator = line.indexOf(" ");
  return separator === -1 ? line : line.slice(0, separator);
}

function isMissingServer(error: unknown): boolean {
  return (
    error instanceof TmuxCommandError &&
    (error.stderr.includes("no server running") ||
      error.stderr.includes("no sessions") ||
      error.stderr.includes("failed to connect to server"))
  );
}

function parseSession(line: string): SessionSummary {
  const fields = line.split("|");
  if (fields.length !== 8) {
    throw new Error(`Unexpected tmux session output: ${line}`);
  }

  const [id, created, attached, processId, dead, deadStatus, cols, rows] =
    fields as [string, string, string, string, string, string, string, string];

  return {
    id,
    createdAt: new Date(parseInteger(created, "session_created") * 1000),
    attached: attached !== "0",
    processId: parseInteger(processId, "pane_pid"),
    exited: dead === "1",
    exitCode:
      dead === "1" && deadStatus.length > 0
        ? parseInteger(deadStatus, "pane_dead_status")
        : null,
    cols: parseInteger(cols, "pane_width"),
    rows: parseInteger(rows, "pane_height"),
  };
}

function parseInteger(value: string, field: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Unexpected tmux ${field}: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  return parsed;
}
