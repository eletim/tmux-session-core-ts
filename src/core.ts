import { randomUUID } from "node:crypto";

import { TmuxClient, TmuxCommandError, type TmuxRunner } from "./tmux.js";

const DEFAULT_SERVER_NAME = "tmux-session-core-ts";
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
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
}

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

    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseSession);
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

function isMissingServer(error: unknown): boolean {
  return (
    error instanceof TmuxCommandError &&
    (error.stderr.includes("no server running") ||
      error.stderr.includes("no sessions") ||
      error.stderr.includes("failed to connect to server"))
  );
}

function parseSession(line: string): Session {
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
