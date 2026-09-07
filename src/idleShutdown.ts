/**
 * Generic idle watchdog for a stdio MCP transport. Deliberately knows nothing
 * about *how* to shut down — that decision (plain `process.exit`, or the
 * Electron app's update-download/open-window guards) belongs to the caller,
 * passed in as `onIdle`. See server.ts's startMcpServer() for the one place
 * this is wired up, and electron/src/main.js for the guarded callback.
 *
 * It's also the single place that decides *whether* this process may stop
 * serving, which is why stdioPipe.ts reports a vanished client here
 * (`clientGone()`) rather than exiting on its own: a dead pipe and a long
 * silence are the same conclusion reached two ways, and both have to clear
 * the same host-supplied guards.
 */

/**
 * The minimal slice of StdioServerTransport this needs — just enough to
 * observe traffic. Declared with method-shorthand syntax (`onmessage?(...)`,
 * not `onmessage?: (...) => void`) so TypeScript checks the parameter
 * bivariantly: StdioServerTransport's real `onmessage` is typed to accept
 * `JSONRPCMessage`, narrower than the `unknown` this module cares about, and
 * only the bivariant (method) form lets that transport be passed in here.
 */
export interface MessageSource {
  onmessage?(message: unknown): void;
}

/**
 * Why the watchdog is proposing shutdown. `'idle'` is the timeout: nothing
 * arrived for `idleMinutes`, and the client may well still be alive and merely
 * quiet. `'client-disconnected'` is certainty rather than inference — the
 * stdio pipe is broken (see stdioPipe.ts), so no request can ever arrive again
 * no matter how long this process waits. A host's guard can treat them
 * differently, but usually shouldn't: both mean there is nothing left to
 * serve, and the reasons to defer (an in-flight update download, a window
 * someone is looking at) don't depend on which one it is.
 */
export type ShutdownReason = 'idle' | 'client-disconnected';

export interface IdleShutdownOptions {
  /** Minutes of silence before `onIdle` fires. `0` (or any non-positive value) disables the watchdog entirely — `watchForIdleShutdown` is then a no-op. */
  idleMinutes: number;
  /**
   * Called once `idleMinutes` have passed with no inbound message. Return
   * `false` (or a Promise resolving to `false`) to defer — the watchdog
   * keeps polling every `recheckMs` and calls `onIdle` again as long as the
   * transport stays silent, rather than waiting out a full `idleMinutes`
   * window again. Any other return value (including `undefined` — the
   * common case, since a callback that actually exits the process never
   * returns) is treated as "handled": the watchdog stops polling for good.
   * A thrown/rejected callback is likewise treated as handled — not
   * retried — so a broken guard can't wedge the watchdog into a fast error
   * loop.
   */
  onIdle: (ctx: {
    idleMinutes: number;
    reason: ShutdownReason;
  }) => boolean | void | Promise<boolean | void>;
  /** How often to poll once the idle threshold has been crossed at least once. Default 60s. */
  recheckMs?: number;
}

export interface IdleShutdownHandle {
  /** Stops the watchdog for good; `onIdle` will not be called again. */
  stop: () => void;
  /**
   * Reports that the client is gone (stdioPipe.ts calls this), running the
   * shutdown decision now rather than waiting out `idleMinutes`. Idempotent in
   * effect: repeat calls just re-run a decision that has already been made or
   * deferred. A no-op when the watchdog is disabled.
   */
  clientGone: () => void;
}

/**
 * Watches `transport` for inbound MCP traffic and calls `onIdle` once
 * `idleMinutes` pass with none. Every JSON-RPC message counts as activity —
 * not just a tool call, also `tools/list`, `initialize`, notifications, a
 * ping — so a client that's merely slow to send its next tool call (rather
 * than gone) never trips this; only genuine silence on the wire does.
 *
 * Hooks in by setting `transport.onmessage` directly, chaining whatever
 * handler is already there. This MUST be called before `server.connect()`:
 * the SDK's `Protocol.connect()` (the base class behind `McpServer`) reads
 * `transport.onmessage` at connect time and wraps it — chaining the prior
 * handler rather than replacing it — so setting ours first means the SDK's
 * own dispatch calls ours too. Calling this after `connect()` would instead
 * silently replace the SDK's handler, and no message would ever reach a
 * tool again.
 *
 * The returned handle's `clientGone()` short-circuits the timeout for the case
 * where waiting is pointless: the pipe is broken, so the transport is not
 * merely quiet but finished. It runs the same guarded, deferrable shutdown
 * decision immediately instead of at the next poll.
 */
export function watchForIdleShutdown(
  transport: MessageSource,
  { idleMinutes, onIdle, recheckMs = 60_000 }: IdleShutdownOptions,
): IdleShutdownHandle {
  // idleMinutes <= 0 means "never auto-quit". That applies to `clientGone()`
  // too: a host that opted out of automatic shutdown didn't ask for one just
  // because the client left. stdioPipe.ts still keeps the process from
  // crashing on the dead pipe either way.
  if (idleMinutes <= 0) return { stop: () => undefined, clientGone: () => undefined };

  const idleMs = idleMinutes * 60_000;
  let lastActivity = Date.now();
  let reason: ShutdownReason = 'idle';
  let handled = false;

  const priorOnMessage = transport.onmessage;
  transport.onmessage = (message: unknown) => {
    lastActivity = Date.now();
    priorOnMessage?.(message);
  };

  const check = () => {
    if (handled) return;
    // A disconnected client skips the clock entirely — there is no amount of
    // further waiting that could produce another message.
    if (reason === 'idle' && Date.now() - lastActivity < idleMs) return;
    Promise.resolve()
      .then(() => onIdle({ idleMinutes, reason }))
      .then((deferred) => {
        // Anything but an explicit `false` means onIdle considers this
        // handled (most commonly because it already exited the process, so
        // this line never even runs) — stop polling rather than calling it
        // again next tick for no reason.
        if (deferred !== false) {
          handled = true;
          clearInterval(timer);
        }
      })
      .catch(() => {
        // A broken onIdle must not wedge this into a fast interval error
        // loop — treat a throw/rejection the same as any other "handled"
        // (non-`false`) result and stop.
        handled = true;
        clearInterval(timer);
      });
  };

  const timer = setInterval(check, recheckMs);
  timer.unref();

  return {
    stop: () => {
      handled = true;
      clearInterval(timer);
    },
    clientGone: () => {
      reason = 'client-disconnected';
      // The interval keeps running, so an onIdle that defers (a window open,
      // an update downloading) is re-asked every recheckMs — same as the
      // timeout path, and still with reason 'client-disconnected'.
      check();
    },
  };
}
