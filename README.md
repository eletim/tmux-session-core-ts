# tmux-session-core-ts

A small TypeScript API for detached terminal sessions. A dedicated tmux server is
the only source of truth: a session exists if and only if it exists in that tmux
server.

## Architecture

`SessionCore` calls the `tmux` executable directly through a thin internal
adapter. By default every command uses `tmux -L tmux-session-core-ts`, so the
user's default tmux server is never read or modified.

There is intentionally no application-side session registry, database,
lifecycle store, or automatic cleanup. `list()` and `get()` query tmux every
time. Session IDs are tmux session names, and process status, exit status, pane
size, and screen contents are all read from tmux.

Created sessions are detached and use tmux's `remain-on-exit` option. This keeps
the pane and its final screen after the command exits. Stopping sends Ctrl-C to
the pane; deleting is the separate, explicit operation that removes the tmux
session.

## Requirements

- Node.js 20 or later
- tmux
- pnpm

## Usage

```ts
import { SessionCore } from "tmux-session-core-ts";

const core = new SessionCore();
const session = await core.create({
  cwd: process.cwd(),
  command: "cat",
});

await core.input(session.id, "hello");
console.log(await core.screen(session.id));

await core.stop(session.id); // sends Ctrl-C; the session remains inspectable
console.log(await core.screen(session.id));
await core.delete(session.id); // removes the tmux session
```

Use an isolated dedicated server name when needed:

```ts
const core = new SessionCore({ serverName: "my-dedicated-server" });
```

The public operations are `create`, `list`, `get`, `screen`, `input`, `resize`,
`stop`, and `delete`. `input` sends the supplied text literally followed by
Enter. IDs and server names accept letters, numbers, `_`, and `-`.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm smoke
```

The smoke script uses a unique dedicated tmux server and launches two separate
Node.js controller processes. The first creates and interacts with a session;
the second rediscovers it directly from tmux, reads its screen, stops it, reads
the final screen, deletes it, and verifies that it disappeared.
