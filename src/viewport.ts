import { createHash } from "node:crypto";

import type { TmuxRunner } from "./tmux.js";

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const MAX_VIEWPORT_ROWS = 10_000;
const MAX_SCROLL_LINES = 10_000;
const MAX_CAPTURE_RETRIES = 3;
const TERMINAL_FACTS_FORMAT = [
  "#{history_size}",
  "#{history_limit}",
  "#{history_bytes}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_dead}",
  "#{alternate_on}",
  "#{mouse_standard_flag}",
  "#{mouse_button_flag}",
  "#{mouse_all_flag}",
  "#{mouse_utf8_flag}",
  "#{mouse_sgr_flag}",
].join("|");

export type ViewportCursor = string & {
  readonly __viewportCursor: "ViewportCursor";
};

export type ViewportFormat = "plain" | "ansi";

export interface ViewportOptions {
  target?:
    | { kind: "live" }
    | { kind: "cursor"; cursor: ViewportCursor }
    | { kind: "fraction"; value: number };
  rows?: number;
  format?: ViewportFormat;
}

export interface TerminalViewport {
  content: string;
  cursor: ViewportCursor;
  live: boolean;
  cols: number;
  screenRows: number;
  viewportRows: number;
  historyRows: number;
  historyLimit: number;
  clamped: boolean;
  rebased: boolean;
}

export interface TerminalCell {
  column: number;
  row: number;
}

export interface ScrollIntent {
  cursor?: ViewportCursor;
  direction: "up" | "down";
  lines: number;
  rows?: number;
  cell?: TerminalCell;
  format?: ViewportFormat;
}

export type ScrollResult =
  { kind: "viewport"; viewport: TerminalViewport } | { kind: "application" };

interface TerminalFacts {
  historyRows: number;
  historyLimit: number;
  historyBytes: number;
  cols: number;
  screenRows: number;
  dead: boolean;
  alternate: boolean;
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
}

interface CursorPayload {
  v: 1;
  s: string;
  o: number;
  h: number;
  hl?: number;
  hb: number;
  c: number;
  r: number;
  a: boolean;
  vr: number;
  m: ViewportFormat;
  f: string;
  vf: string;
}

interface ResolvedPosition {
  offset: number;
  clamped: boolean;
  rebased: boolean;
  expectedViewportFingerprint?: string;
}

interface ViewportPosition extends ResolvedPosition {
  rows: number;
  rowsFollowScreen: boolean;
  format: ViewportFormat;
  cursorAnchored: boolean;
}

export async function readViewport(
  tmux: TmuxRunner,
  id: string,
  options: ViewportOptions = {},
): Promise<TerminalViewport> {
  assertViewportTarget(options.target);
  const payload =
    options.target?.kind === "cursor"
      ? decodeCursor(options.target.cursor, id)
      : undefined;
  const facts = await readTerminalFacts(tmux, id);
  const rows = resolveRequestedRows(
    options.rows,
    payload?.vr,
    facts.screenRows,
  );
  const format = resolveFormat(options.format ?? payload?.m);

  let position: ResolvedPosition;
  if (payload !== undefined) {
    position = await resolveCursor(tmux, id, payload, facts, rows, format);
  } else if (options.target?.kind === "fraction") {
    position = {
      offset: Math.round((1 - options.target.value) * facts.historyRows),
      clamped: false,
      rebased: false,
    };
  } else {
    position = { offset: 0, clamped: false, rebased: false };
  }

  return captureViewport(tmux, id, facts, {
    ...position,
    rows,
    rowsFollowScreen: options.rows === undefined && payload === undefined,
    format,
    cursorAnchored: payload !== undefined,
  });
}

export async function applyScroll(
  tmux: TmuxRunner,
  id: string,
  intent: ScrollIntent,
): Promise<ScrollResult> {
  assertScrollIntent(intent);
  const payload =
    intent.cursor === undefined ? undefined : decodeCursor(intent.cursor, id);
  const facts = await readTerminalFacts(tmux, id);
  const rows = resolveRequestedRows(intent.rows, payload?.vr, facts.screenRows);
  const format = resolveFormat(intent.format ?? payload?.m);
  const resolved =
    payload === undefined
      ? { offset: 0, clamped: false, rebased: false }
      : await resolveCursor(tmux, id, payload, facts, rows, format);

  if (payload !== undefined && payload.o > 0) {
    return {
      kind: "viewport",
      viewport: await moveViewport(
        tmux,
        id,
        facts,
        resolved,
        intent,
        rows,
        format,
        true,
        false,
      ),
    };
  }

  if (!facts.dead && applicationOwnsMouse(facts)) {
    const cell = normalizeCell(intent.cell, facts);
    const input = mouseInput(intent.direction, cell, facts).repeat(
      intent.lines,
    );
    await tmux.run(["send-keys", "-t", id, "-l", "--", input]);
    return { kind: "application" };
  }

  if (!facts.dead && facts.alternate) {
    await tmux.run([
      "send-keys",
      "-N",
      String(intent.lines),
      "-t",
      id,
      intent.direction === "up" ? "Up" : "Down",
    ]);
    return { kind: "application" };
  }

  return {
    kind: "viewport",
    viewport: await moveViewport(
      tmux,
      id,
      facts,
      resolved,
      intent,
      rows,
      format,
      payload !== undefined,
      intent.rows === undefined && payload === undefined,
    ),
  };
}

async function moveViewport(
  tmux: TmuxRunner,
  id: string,
  facts: TerminalFacts,
  current: ResolvedPosition,
  intent: ScrollIntent,
  rows: number,
  format: ViewportFormat,
  cursorAnchored: boolean,
  rowsFollowScreen: boolean,
): Promise<TerminalViewport> {
  const requested =
    current.offset + (intent.direction === "up" ? intent.lines : -intent.lines);
  const offset = clamp(requested, 0, facts.historyRows);
  const expectedViewportFingerprint = cursorAnchored
    ? fingerprint(await captureRows(tmux, id, offset, rows, format))
    : undefined;
  return captureViewport(tmux, id, facts, {
    offset,
    rows,
    rowsFollowScreen,
    format,
    clamped: current.clamped || offset !== requested,
    rebased: current.rebased,
    cursorAnchored,
    ...(expectedViewportFingerprint === undefined
      ? {}
      : { expectedViewportFingerprint }),
  });
}

async function captureViewport(
  tmux: TmuxRunner,
  id: string,
  facts: TerminalFacts,
  position: ViewportPosition,
  attempt = 0,
): Promise<TerminalViewport> {
  const content = await captureRows(
    tmux,
    id,
    position.offset,
    position.rows,
    position.format,
  );
  const latestFacts = await readTerminalFacts(tmux, id);
  const snapshotChanged = !sameCaptureSnapshot(facts, latestFacts);
  const contentChanged =
    position.cursorAnchored &&
    position.expectedViewportFingerprint !== undefined &&
    fingerprint(content) !== position.expectedViewportFingerprint;
  if (snapshotChanged || contentChanged) {
    if (attempt >= MAX_CAPTURE_RETRIES) {
      throw new Error(
        `Terminal state did not stabilize while capturing session ${id}`,
      );
    }
    const geometryChanged =
      facts.cols !== latestFacts.cols ||
      facts.screenRows !== latestFacts.screenRows ||
      facts.alternate !== latestFacts.alternate;
    const historyChanged =
      facts.historyRows !== latestFacts.historyRows ||
      facts.historyLimit !== latestFacts.historyLimit ||
      facts.historyBytes !== latestFacts.historyBytes;
    const historyGrowth = latestFacts.historyRows - facts.historyRows;
    const pureAppend =
      !geometryChanged && isReliablePureAppend(facts, latestFacts);
    let requestedOffset = position.offset;
    if (position.offset > 0 && pureAppend) {
      requestedOffset += historyGrowth;
    } else if (geometryChanged || historyChanged || contentChanged) {
      requestedOffset = Math.round(
        (position.offset / Math.max(facts.historyRows, 1)) *
          latestFacts.historyRows,
      );
    }
    const offset = clamp(requestedOffset, 0, latestFacts.historyRows);
    const rows = position.rowsFollowScreen
      ? latestFacts.screenRows
      : Math.min(position.rows, latestFacts.screenRows);
    const expectedViewportFingerprint = position.cursorAnchored
      ? fingerprint(await captureRows(tmux, id, offset, rows, position.format))
      : undefined;
    const retryRebased =
      position.rebased ||
      (position.cursorAnchored &&
        (geometryChanged ||
          (position.offset > 0 &&
            ((historyChanged && !pureAppend) ||
              (contentChanged && !pureAppend)))));

    return captureViewport(
      tmux,
      id,
      latestFacts,
      {
        ...position,
        offset,
        rows,
        clamped: position.clamped || offset !== requestedOffset,
        rebased: retryRebased,
        ...(expectedViewportFingerprint === undefined
          ? {}
          : { expectedViewportFingerprint }),
      },
      attempt + 1,
    );
  }
  const cursor = encodeCursor({
    v: CURSOR_VERSION,
    s: id,
    o: position.offset,
    h: facts.historyRows,
    hl: facts.historyLimit,
    hb: facts.historyBytes,
    c: facts.cols,
    r: facts.screenRows,
    a: facts.alternate,
    vr: position.rows,
    m: position.format,
    f: fingerprint(firstRow(content)),
    vf: fingerprint(content),
  });

  return {
    content,
    cursor,
    live: position.offset === 0,
    cols: facts.cols,
    screenRows: facts.screenRows,
    viewportRows: position.rows,
    historyRows: facts.historyRows,
    historyLimit: facts.historyLimit,
    clamped: position.clamped,
    rebased: position.rebased,
  };
}

function sameCaptureSnapshot(
  before: TerminalFacts,
  after: TerminalFacts,
): boolean {
  return (
    before.historyRows === after.historyRows &&
    before.historyLimit === after.historyLimit &&
    before.historyBytes === after.historyBytes &&
    before.cols === after.cols &&
    before.screenRows === after.screenRows &&
    before.dead === after.dead &&
    before.alternate === after.alternate
  );
}

function isReliablePureAppend(
  before: TerminalFacts,
  after: TerminalFacts,
): boolean {
  return (
    before.historyLimit === after.historyLimit &&
    after.historyRows > before.historyRows &&
    after.historyRows < after.historyLimit &&
    after.historyBytes >= before.historyBytes
  );
}

async function resolveCursor(
  tmux: TmuxRunner,
  id: string,
  payload: CursorPayload,
  facts: TerminalFacts,
  rows: number,
  format: ViewportFormat,
): Promise<ResolvedPosition> {
  const geometryChanged =
    payload.c !== facts.cols ||
    payload.r !== facts.screenRows ||
    payload.a !== facts.alternate;
  const historyUnchanged =
    payload.h === facts.historyRows && payload.hb === facts.historyBytes;
  const pureAppend =
    payload.hl === facts.historyLimit &&
    facts.historyRows > payload.h &&
    facts.historyRows < facts.historyLimit &&
    facts.historyBytes >= payload.hb;
  const historyChanged =
    payload.h !== facts.historyRows || payload.hb !== facts.historyBytes;
  let rebased = geometryChanged;
  let offset: number;

  if (payload.o === 0) {
    offset = 0;
  } else if (!geometryChanged && historyUnchanged) {
    offset = payload.o;
  } else if (!geometryChanged && pureAppend) {
    offset = payload.o + (facts.historyRows - payload.h);
  } else {
    offset = relativeOffset(payload, facts.historyRows);
    rebased ||= historyChanged;
  }

  const unclamped = offset;
  offset = clamp(offset, 0, facts.historyRows);
  let clamped = offset !== unclamped;
  let expectedViewportFingerprint: string | undefined;

  if (payload.o > 0 && !geometryChanged) {
    const candidateOffset = offset;
    const candidate = await captureRows(
      tmux,
      id,
      offset,
      payload.vr,
      payload.m,
    );
    const compareFullViewport = !pureAppend;
    const candidateFingerprint = fingerprint(
      compareFullViewport ? candidate : firstRow(candidate),
    );
    const expectedFingerprint = compareFullViewport ? payload.vf : payload.f;
    if (candidateFingerprint !== expectedFingerprint) {
      rebased = true;
      const relative = relativeOffset(payload, facts.historyRows);
      const adjusted = clamp(relative, 0, facts.historyRows);
      clamped ||= adjusted !== relative;
      offset = adjusted;
    } else if (
      offset === candidateOffset &&
      rows === payload.vr &&
      format === payload.m
    ) {
      expectedViewportFingerprint = fingerprint(candidate);
    }
  }

  expectedViewportFingerprint ??= fingerprint(
    await captureRows(tmux, id, offset, rows, format),
  );

  return { offset, clamped, rebased, expectedViewportFingerprint };
}

function relativeOffset(
  payload: CursorPayload,
  currentHistoryRows: number,
): number {
  if (payload.h === 0) {
    return 0;
  }
  return Math.round((payload.o / payload.h) * currentHistoryRows);
}

async function readTerminalFacts(
  tmux: TmuxRunner,
  id: string,
): Promise<TerminalFacts> {
  const output = await tmux.run([
    "display-message",
    "-p",
    "-t",
    id,
    TERMINAL_FACTS_FORMAT,
  ]);
  const fields = output.trimEnd().split("|");
  if (fields.length !== 12) {
    throw new Error(`Unexpected terminal state for session ${id}: ${output}`);
  }
  const [
    historyRows,
    historyLimit,
    historyBytes,
    cols,
    screenRows,
    dead,
    alternate,
    mouseStandard,
    mouseButton,
    mouseAll,
    mouseUtf8,
    mouseSgr,
  ] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    historyRows: parseFactInteger(historyRows, "history size"),
    historyLimit: parseFactInteger(historyLimit, "history limit"),
    historyBytes: parseFactInteger(historyBytes, "history bytes"),
    cols: parsePositiveFactInteger(cols, "pane width"),
    screenRows: parsePositiveFactInteger(screenRows, "pane height"),
    dead: parseFlag(dead),
    alternate: parseFlag(alternate),
    mouseStandard: parseFlag(mouseStandard),
    mouseButton: parseFlag(mouseButton),
    mouseAll: parseFlag(mouseAll),
    mouseUtf8: parseFlag(mouseUtf8),
    mouseSgr: parseFlag(mouseSgr),
  };
}

async function captureRows(
  tmux: TmuxRunner,
  id: string,
  offset: number,
  rows: number,
  format: ViewportFormat,
): Promise<string> {
  const start = -offset;
  const end = start + rows - 1;
  return tmux.run([
    "capture-pane",
    "-p",
    ...(format === "ansi" ? ["-e"] : []),
    "-S",
    String(start),
    "-E",
    String(end),
    "-t",
    id,
  ]);
}

function applicationOwnsMouse(facts: TerminalFacts): boolean {
  return facts.mouseStandard || facts.mouseButton || facts.mouseAll;
}

function normalizeCell(
  cell: TerminalCell | undefined,
  facts: TerminalFacts,
): TerminalCell {
  return {
    column: clamp(cell?.column ?? 1, 1, facts.cols),
    row: clamp(cell?.row ?? 1, 1, facts.screenRows),
  };
}

function mouseInput(
  direction: ScrollIntent["direction"],
  cell: TerminalCell,
  facts: TerminalFacts,
): string {
  const button = direction === "up" ? 64 : 65;
  if (facts.mouseSgr) {
    return `\u001b[<${button};${cell.column};${cell.row}M`;
  }

  const maxCoordinate = facts.mouseUtf8 ? 2015 : 223;
  const column = Math.min(cell.column, maxCoordinate);
  const row = Math.min(cell.row, maxCoordinate);
  return "\u001b[M" + String.fromCodePoint(button + 32, column + 32, row + 32);
}

function encodeCursor(payload: CursorPayload): ViewportCursor {
  return Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  ) as ViewportCursor;
}

function decodeCursor(cursor: ViewportCursor, id: string): CursorPayload {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }

  if (!isCursorPayload(value) || value.s !== id) {
    throw invalidCursor();
  }
  return value;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === CURSOR_VERSION &&
    typeof candidate.s === "string" &&
    isNonNegativeInteger(candidate.o) &&
    isNonNegativeInteger(candidate.h) &&
    candidate.o <= candidate.h &&
    (candidate.hl === undefined || isNonNegativeInteger(candidate.hl)) &&
    isNonNegativeInteger(candidate.hb) &&
    isPositiveInteger(candidate.c) &&
    isPositiveInteger(candidate.r) &&
    typeof candidate.a === "boolean" &&
    isPositiveInteger(candidate.vr) &&
    candidate.vr <= MAX_VIEWPORT_ROWS &&
    (candidate.m === "plain" || candidate.m === "ansi") &&
    typeof candidate.f === "string" &&
    /^[a-f0-9]{16}$/.test(candidate.f) &&
    typeof candidate.vf === "string" &&
    /^[a-f0-9]{16}$/.test(candidate.vf)
  );
}

function invalidCursor(): TypeError {
  return new TypeError("Invalid viewport cursor");
}

function assertViewportTarget(target: ViewportOptions["target"]): void {
  if (target === undefined || target.kind === "live") {
    return;
  }
  if (target.kind === "cursor") {
    if (typeof target.cursor !== "string") {
      throw invalidCursor();
    }
    return;
  }
  if (
    target.kind !== "fraction" ||
    !Number.isFinite(target.value) ||
    target.value < 0 ||
    target.value > 1
  ) {
    throw new TypeError("viewport fraction must be between 0 and 1");
  }
}

function assertScrollIntent(intent: ScrollIntent): void {
  if (intent.direction !== "up" && intent.direction !== "down") {
    throw new TypeError('scroll direction must be "up" or "down"');
  }
  if (
    !Number.isSafeInteger(intent.lines) ||
    intent.lines <= 0 ||
    intent.lines > MAX_SCROLL_LINES
  ) {
    throw new TypeError(
      `scroll lines must be a positive integer no greater than ${MAX_SCROLL_LINES}`,
    );
  }
  if (
    intent.cell !== undefined &&
    (!isPositiveInteger(intent.cell.column) ||
      !isPositiveInteger(intent.cell.row))
  ) {
    throw new TypeError("scroll cell coordinates must be positive integers");
  }
  if (intent.rows !== undefined) {
    assertRequestedRows(intent.rows);
  }
  if (intent.format !== undefined) {
    resolveFormat(intent.format);
  }
}

function resolveRows(rows: number | undefined, screenRows: number): number {
  const resolved = rows ?? screenRows;
  assertRequestedRows(resolved);
  if (resolved > screenRows) {
    throw new TypeError(
      "viewport rows must not exceed the terminal screen rows",
    );
  }
  return resolved;
}

function resolveRequestedRows(
  explicitRows: number | undefined,
  cursorRows: number | undefined,
  screenRows: number,
): number {
  if (explicitRows !== undefined) {
    return resolveRows(explicitRows, screenRows);
  }
  return resolveRows(
    cursorRows === undefined ? undefined : Math.min(cursorRows, screenRows),
    screenRows,
  );
}

function assertRequestedRows(rows: number): void {
  if (!isPositiveInteger(rows) || rows > MAX_VIEWPORT_ROWS) {
    throw new TypeError(
      `viewport rows must be a positive integer no greater than ${MAX_VIEWPORT_ROWS}`,
    );
  }
}

function resolveFormat(format: ViewportFormat | undefined): ViewportFormat {
  const resolved = format ?? "plain";
  if (resolved !== "plain" && resolved !== "ansi") {
    throw new TypeError('viewport format must be "plain" or "ansi"');
  }
  return resolved;
}

function parseFactInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Unexpected terminal ${name}: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Unexpected terminal ${name}: ${value}`);
  }
  return parsed;
}

function parsePositiveFactInteger(value: string, name: string): number {
  const parsed = parseFactInteger(value, name);
  if (parsed === 0) {
    throw new Error(`Unexpected terminal ${name}: ${value}`);
  }
  return parsed;
}

function parseFlag(value: string): boolean {
  return value === "1";
}

function firstRow(content: string): string {
  const newline = content.indexOf("\n");
  return newline === -1 ? content : content.slice(0, newline);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
