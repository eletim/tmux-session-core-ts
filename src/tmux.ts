import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxRunner {
  run(args: readonly string[]): Promise<string>;
}

export class TmuxCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string, cause: unknown) {
    super(
      `tmux ${args.join(" ")} failed: ${stderr.trim() || "unknown error"}`,
      {
        cause,
      },
    );
    this.name = "TmuxCommandError";
    this.args = args;
    this.stderr = stderr;
  }
}

export class TmuxClient implements TmuxRunner {
  constructor(private readonly serverName: string) {}

  async run(args: readonly string[]): Promise<string> {
    const tmuxArgs = ["-L", this.serverName, ...args];

    try {
      const { stdout } = await execFileAsync("tmux", tmuxArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = getStderr(error);
      throw new TmuxCommandError(tmuxArgs, stderr, error);
    }
  }
}

function getStderr(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return error.stderr;
  }
  return "";
}
