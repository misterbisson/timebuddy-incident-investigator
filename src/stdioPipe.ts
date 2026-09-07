/**
 * Survives the one failure every stdio MCP server eventually hits: the client
 * that spawned it going away while this process is still holding a write.
 *
 * Nothing in the SDK's `StdioServerTransport` guards that. Its `send()` calls
 * `process.stdout.write(json)` and only ever waits for `'drain'` — so once
 * Claude Code/Desktop exits, the very next response write fails with `EPIPE`,
 * which arrives as an `'error'` event on stdout with no listener attached.
 * An unhandled stream error is an uncaught exception, and the consequences
 * differ badly by host: the standalone CLI dies with a stack trace on stderr
 * nobody is reading, while the Electron `--mcp-server` process — which is
 * GUI-capable even though it deliberately never opens a window — hits
 * Electron's default handler and shows a modal "A JavaScript error occurred in
 * the main process" dialog. That dialog is the worst outcome of the three: it
 * appears with no window and no app to attach it to, it can't be explained by
 * anything the user was doing (their editor session ended minutes or hours
 * earlier), and while it's up the process is wedged — it can't even take the
 * idle-shutdown path (idleShutdown.ts) that exists to clean these up, so it
 * sits on screen until somebody clicks OK.
 *
 * So this module does two things, and the split matters:
 *
 *   1. **Never crash on a dead pipe.** A failed write to a client that no
 *      longer exists is expected operation, not an error condition — there is
 *      nobody left to report it to, which is precisely why it must not be
 *      raised as an exception. Swallowed unconditionally.
 *   2. **Treat a dead pipe as the session being over.** stdin closing or a
 *      write failing both mean no further JSON-RPC can ever be exchanged on
 *      this transport, so the process has nothing left to serve. That's the
 *      same conclusion the idle watchdog reaches after `idleShutdownMinutes`
 *      of silence, just reached immediately and with certainty rather than by
 *      timeout — which is why this reports it *to* that watchdog
 *      (`clientGone()`) instead of exiting on its own. Every reason not to
 *      quit yet already lives there and in its host's callback (an update
 *      mid-download, an open Activity/Connections window — see
 *      electron/src/main.js's idleShutdownGuard).
 *
 * Point 2 is deliberately subordinate to the host's configuration: with the
 * watchdog disabled (`idleShutdownMinutes` <= 0, i.e. "never auto-quit"),
 * `clientGone()` is a no-op and this process lingers exactly as asked. Point 1
 * still applies — "don't auto-quit" is not a request to crash instead.
 */

/**
 * Error codes that mean "the other end of the pipe is gone", as opposed to
 * "that write was malformed". `EPIPE` is the one seen in practice (the reader
 * closed); the rest cover the same fault racing our own teardown, and are
 * treated identically because the response is identical: stop writing, the
 * session is over.
 */
const DISCONNECT_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
]);

/** True when `err` means the client's end of our stdio pipe has gone away. */
export function isDisconnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && DISCONNECT_CODES.has(code);
}

/**
 * The slices of `process.stdout`/`process.stdin` this needs. Kept minimal and
 * structural so tests can pass plain EventEmitters, and declared with method
 * shorthand (`on(...)`, not `on: (...) => void`) so the real streams' far
 * richer overloads stay assignable.
 */
export interface ErrorEventSource {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  off?(event: 'error', listener: (err: unknown) => void): unknown;
}

export interface EndEventSource {
  on(event: 'end', listener: () => void): unknown;
  off?(event: 'end', listener: () => void): unknown;
}

/**
 * The transport's own write path. Typed `never[]` so any concrete `send`
 * signature (the SDK's `(message, options?)`) is assignable and this wrapper
 * stays agnostic about what a message is — it inspects failures, never
 * payloads.
 */
export interface SendingTransport {
  send(...args: never[]): Promise<void>;
}

export type ClientGoneReason = 'stdin-closed' | 'write-failed';

export interface StdioPipeGuardOptions {
  /**
   * Called at most once, the first time this process learns the client is
   * gone. Expected to hand off to the idle watchdog's `clientGone()` rather
   * than exit directly — see this module's header for why the shutdown
   * decision belongs there.
   */
  onClientGone?: (ctx: { reason: ClientGoneReason; error?: unknown }) => void;
  /** Defaults to `process.stdout` — the JSON-RPC channel whose writes can fail. */
  stdout?: ErrorEventSource;
  /** Defaults to `process.stdin` — EOF here is the cleanest "client exited" signal there is. */
  stdin?: EndEventSource;
  /** Where to report. Defaults to console.error: stdout is the JSON-RPC channel, never a log. */
  log?: (message: string) => void;
}

/**
 * Makes `transport`'s writes fail-soft and reports client disappearance
 * exactly once. Safe to call before or after `server.connect()` — unlike
 * `watchForIdleShutdown`, this wraps `send` (the outbound half, which the SDK
 * never re-reads) rather than `onmessage`, so there's no ordering constraint
 * against the SDK's own handler chaining.
 *
 * `stop()` undoes everything: detaches the stream listeners and restores the
 * original `send`. Only tests need it; the process itself keeps the guard for
 * its whole life.
 */
export function guardStdioPipe(
  transport: SendingTransport,
  {
    onClientGone,
    stdout = process.stdout,
    stdin = process.stdin,
    log = (message: string) => console.error(message),
  }: StdioPipeGuardOptions = {},
): { stop: () => void } {
  let reported = false;
  const reportClientGone = (reason: ClientGoneReason, error?: unknown) => {
    if (reported) return;
    reported = true;
    log(`[stdio] MCP client is gone (${reason}); no further requests can arrive on this transport`);
    onClientGone?.({ reason, error });
  };

  const onStdoutError = (err: unknown) => {
    if (isDisconnectError(err)) {
      reportClientGone('write-failed', err);
      return;
    }
    // Not a disconnect: still must not go unhandled (that's the crash this
    // module exists to prevent), but it isn't evidence the client left, so it
    // gets reported without triggering shutdown.
    log(`[stdio] error writing to stdout: ${err instanceof Error ? err.message : String(err)}`);
  };
  stdout.on('error', onStdoutError);

  // stdin reaching EOF means the parent closed its end: no further JSON-RPC
  // request can ever arrive, whatever else is still running here. The SDK's
  // transport listens only for 'data'/'error' on stdin, never 'end', so
  // without this the first thing to notice a departed client is a failed
  // write — which is exactly the path that used to crash.
  const onStdinEnd = () => reportClientGone('stdin-closed');
  stdin.on('end', onStdinEnd);

  // Belt to the stream-listener braces above: an 'error' event covers the
  // asynchronous EPIPE (the observed case), while this covers a write that
  // throws synchronously or rejects — on Node's default
  // --unhandled-rejections=throw that would crash just as loudly, and from a
  // stack that names none of this.
  // Captured unbound (and invoked with .call below) so `stop()` can restore
  // the exact same function reference the caller had, rather than a bound
  // copy that merely behaves the same.
  const originalSend = transport.send;
  const guardedSend = (...args: never[]): Promise<void> => {
    try {
      return originalSend.call(transport, ...args).catch((err: unknown) => {
        if (!isDisconnectError(err)) throw err;
        reportClientGone('write-failed', err);
      });
    } catch (err) {
      if (!isDisconnectError(err)) throw err;
      reportClientGone('write-failed', err);
      return Promise.resolve();
    }
  };
  transport.send = guardedSend;

  return {
    stop: () => {
      stdout.off?.('error', onStdoutError);
      stdin.off?.('end', onStdinEnd);
      if (transport.send === guardedSend) transport.send = originalSend;
    },
  };
}
