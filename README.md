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
size, cwd, current command, and screen contents are all read from tmux.

Client-owned string metadata that tmux does not know natively is stored as
session-scoped tmux user options named `@tmux_session_core_<key>`. Metadata is
also read fresh from tmux: the Core has no metadata cache or restoration step.
Only options in this namespace with valid keys are returned. Native facts such
as cwd and current command remain native tmux values and must not be copied into
metadata for convenience.

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
await core.input(session.id, "\u001b[A", { submit: false }); // raw TUI input
console.log(await core.screen(session.id));

const live = await core.viewport(session.id);
const older = await core.scroll(session.id, {
  cursor: live.cursor,
  direction: "up",
  lines: 10,
});
if (older.kind === "viewport") {
  console.log(older.viewport.content);
}

await core.setMetadata(session.id, "title", "Client-owned title 🌏");
console.log(session.cwd, session.currentCommand);
console.log(await core.listMetadata(session.id));

await core.stop(session.id); // sends Ctrl-C; the session remains inspectable
console.log(await core.screen(session.id));
await core.delete(session.id); // removes the tmux session
```

Use an isolated dedicated server name when needed:

```ts
const core = new SessionCore({ serverName: "my-dedicated-server" });
```

The public operations are `create`, `list`, `get`, `screen`, `viewport`,
`scroll`, `input`, `resize`, `stop`, `delete`, `setMetadata`, `getMetadata`,
`listMetadata`, and `deleteMetadata`. `input` sends the supplied text literally
followed by Enter. IDs and server names accept letters, numbers, `_`, and `-`.
`input` appends Enter by default; pass `{ submit: false }` for raw terminal bytes
from an interactive client.

Metadata keys must match `[A-Za-z0-9][A-Za-z0-9_-]*`. Values are strings;
Unicode and the empty string are preserved. `getMetadata` returns `undefined`
for a missing key. Deleting a metadata key does not affect its session, while
deleting the tmux session naturally deletes all its session-scoped metadata.

## Terminal viewports and scrolling

`viewport()` is the UI-oriented way to read a terminal. With no options it
returns the live screen as physical terminal rows. It can also read an older
position by cursor or seek to a scrollbar-like fraction, where `0` is the
oldest retained position and `1` is live:

```ts
const live = await core.viewport(sessionId, {
  format: "ansi",
});

const middle = await core.viewport(sessionId, {
  target: { kind: "fraction", value: 0.5 },
  rows: 20,
});

const next = await core.scroll(sessionId, {
  cursor: middle.cursor,
  direction: "down",
  lines: 3,
});
```

The `ViewportCursor` is opaque and request-scoped. A client stores it and sends
it back unchanged; it must not decode or construct one. The cursor contains all
position information needed by a new `SessionCore` instance, so the Core has no
viewer registry or scroll-position map. Desktop, mobile, and separate browser
tabs can therefore hold independent cursors for one session.

At a normal live terminal, `scroll()` navigates retained terminal history. If a
foreground full-screen application owns wheel input, the same terminal-level
intent is delivered to that application and the result is
`{ kind: "application" }`. Callers never need to construct mouse reports or use
terminal-backend UI commands. A caller already viewing history always moves only
its own viewport.

History positions are physical rows at the terminal's current width. A resize
may reflow them, and old rows are eventually evicted at the history limit. The
Core deterministically clamps or rebases an affected cursor and reports that in
`TerminalViewport.clamped` and `TerminalViewport.rebased`; cursors are not
permanent content bookmarks. `format: "plain"` returns text, while
`format: "ansi"` includes terminal styling for a compatible renderer.

`screen()` remains the compatibility API: it returns the legacy joined dump of
the full retained history plus the active screen. It joins wrapped rows and is
not the current viewport. New terminal UIs should use `viewport()` and
`scroll()`.

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
the second rediscovers its native facts, metadata, screen, and viewport directly
from the persistent terminal server, round-trips an opaque viewport cursor
through a new Core instance, updates and deletes metadata, stops the session,
reads its final screen, deletes it, and verifies that the session and metadata
disappeared together.
