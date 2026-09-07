import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchForIdleShutdown } from '../src/idleShutdown.js';

describe('watchForIdleShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when idleMinutes is 0 or negative', async () => {
    const onIdle = vi.fn();
    const transport: { onmessage?: (m: unknown) => void } = {};
    watchForIdleShutdown(transport, { idleMinutes: 0, onIdle });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    // transport.onmessage is left untouched — no watchdog wiring happened.
    expect(transport.onmessage).toBeUndefined();
  });

  it('fires onIdle once the idle window elapses with no messages', async () => {
    const onIdle = vi.fn();
    const transport: { onmessage?: (m: unknown) => void } = {};
    watchForIdleShutdown(transport, { idleMinutes: 5, recheckMs: 1_000, onIdle });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith({ idleMinutes: 5, reason: 'idle' });
  });

  it('resets the clock on every inbound message, including ones the prior handler already had', async () => {
    const onIdle = vi.fn();
    const priorSeen: unknown[] = [];
    const transport: { onmessage?: (m: unknown) => void } = {
      onmessage: (m) => priorSeen.push(m),
    };
    watchForIdleShutdown(transport, { idleMinutes: 5, recheckMs: 1_000, onIdle });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    transport.onmessage?.('tool-call');
    expect(priorSeen).toEqual(['tool-call']); // chained, not replaced

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled(); // only 4m since the reset

    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('keeps polling and re-invoking onIdle while it defers by returning false', async () => {
    const onIdle = vi.fn().mockReturnValue(false);
    const transport: { onmessage?: (m: unknown) => void } = {};
    watchForIdleShutdown(transport, { idleMinutes: 5, recheckMs: 1_000, onIdle });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onIdle).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onIdle).toHaveBeenCalledTimes(3);
  });

  it('treats a thrown/rejecting onIdle as handled rather than looping', async () => {
    const onIdle = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const transport: { onmessage?: (m: unknown) => void } = {};
    watchForIdleShutdown(transport, { idleMinutes: 5, recheckMs: 1_000, onIdle });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the timer so onIdle never fires again', async () => {
    const onIdle = vi.fn();
    const transport: { onmessage?: (m: unknown) => void } = {};
    const { stop } = watchForIdleShutdown(transport, { idleMinutes: 5, recheckMs: 1_000, onIdle });

    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  describe('clientGone()', () => {
    it('shuts down immediately rather than waiting out the idle window', async () => {
      const onIdle = vi.fn();
      const transport: { onmessage?: (m: unknown) => void } = {};
      const { clientGone } = watchForIdleShutdown(transport, {
        idleMinutes: 30,
        recheckMs: 1_000,
        onIdle,
      });

      // Well inside the idle window: the timeout path would not have fired.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onIdle).not.toHaveBeenCalled();

      clientGone();
      await vi.advanceTimersByTimeAsync(0);
      expect(onIdle).toHaveBeenCalledTimes(1);
      expect(onIdle).toHaveBeenCalledWith({ idleMinutes: 30, reason: 'client-disconnected' });
    });

    it('keeps re-asking a deferring guard, still reporting client-disconnected', async () => {
      const onIdle = vi.fn().mockReturnValue(false);
      const transport: { onmessage?: (m: unknown) => void } = {};
      const { clientGone } = watchForIdleShutdown(transport, {
        idleMinutes: 30,
        recheckMs: 1_000,
        onIdle,
      });

      clientGone();
      await vi.advanceTimersByTimeAsync(0);
      expect(onIdle).toHaveBeenCalledTimes(1);

      // A window still open / update still downloading: asked again next poll,
      // and the reason doesn't decay back to 'idle'.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onIdle).toHaveBeenCalledTimes(2);
      expect(onIdle).toHaveBeenLastCalledWith({ idleMinutes: 30, reason: 'client-disconnected' });
    });

    it('does not fire a second decision once one was handled', async () => {
      const onIdle = vi.fn();
      const transport: { onmessage?: (m: unknown) => void } = {};
      const { clientGone } = watchForIdleShutdown(transport, {
        idleMinutes: 30,
        recheckMs: 1_000,
        onIdle,
      });

      clientGone();
      await vi.advanceTimersByTimeAsync(0);
      clientGone();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the watchdog is disabled — "never auto-quit" includes this path', async () => {
      const onIdle = vi.fn();
      const transport: { onmessage?: (m: unknown) => void } = {};
      const { clientGone } = watchForIdleShutdown(transport, { idleMinutes: 0, onIdle });

      clientGone();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
