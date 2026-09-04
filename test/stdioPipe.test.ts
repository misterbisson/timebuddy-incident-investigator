import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guardStdioPipe, isDisconnectError } from '../src/stdioPipe.js';

/**
 * A plain EventEmitter is the right stand-in for process.stdout here, not a
 * convenience: emitting 'error' on an emitter with no listener *throws*, which
 * is exactly the uncaught-exception path that crashed the real process. So
 * "emitting EPIPE doesn't throw" is a real assertion about the bug, not just a
 * check that some listener exists.
 */
function fakeStreams() {
  return { stdout: new EventEmitter(), stdin: new EventEmitter() };
}

function epipe() {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('isDisconnectError', () => {
  it('recognizes the codes that mean the pipe is gone', () => {
    expect(isDisconnectError(epipe())).toBe(true);
    expect(isDisconnectError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isDisconnectError(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isDisconnectError(new Error('serialization blew up'))).toBe(false);
    expect(isDisconnectError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isDisconnectError(undefined)).toBe(false);
    expect(isDisconnectError(null)).toBe(false);
    expect(isDisconnectError('EPIPE')).toBe(false);
  });
});

describe('guardStdioPipe', () => {
  it('turns an EPIPE on stdout from a crash into a client-gone report', () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockResolvedValue(undefined) };
    guardStdioPipe(transport, { stdout, stdin, onClientGone, log: () => undefined });

    // Would throw (uncaught exception) if the guard hadn't attached a listener.
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'write-failed', error: expect.any(Error) });
  });

  it('treats stdin EOF as the client being gone', () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stdin, onClientGone, log: () => undefined });

    stdin.emit('end');
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'stdin-closed', error: undefined });
  });

  it('reports the client gone at most once, however many signals arrive', () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stdin, onClientGone, log: () => undefined });

    stdin.emit('end');
    stdout.emit('error', epipe());
    stdout.emit('error', epipe());
    expect(onClientGone).toHaveBeenCalledTimes(1);
  });

  it('handles a non-disconnect stdout error without crashing or claiming the client left', () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stdin, onClientGone, log });

    expect(() => stdout.emit('error', new Error('disk on fire'))).not.toThrow();
    expect(onClientGone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk on fire'));
  });

  it('resolves rather than rejecting when send rejects with a disconnect', async () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockRejectedValue(epipe()) };
    guardStdioPipe(transport, { stdout, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).resolves.toBeUndefined();
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'write-failed', error: expect.any(Error) });
  });

  it('resolves when send throws a disconnect synchronously', async () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = {
      send: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
      }),
    };
    guardStdioPipe(transport, { stdout, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).resolves.toBeUndefined();
    expect(onClientGone).toHaveBeenCalledTimes(1);
  });

  it('leaves genuine send failures alone — only pipe death is swallowed', async () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockRejectedValue(new Error('message too large')) };
    guardStdioPipe(transport, { stdout, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).rejects.toThrow('message too large');
    expect(onClientGone).not.toHaveBeenCalled();
  });

  it('passes successful sends straight through, arguments intact', async () => {
    const { stdout, stdin } = fakeStreams();
    const inner = vi.fn().mockResolvedValue(undefined);
    const transport = { send: inner };
    guardStdioPipe(transport, { stdout, stdin, log: () => undefined });

    await expect(transport.send({ jsonrpc: '2.0', id: 1 } as never)).resolves.toBeUndefined();
    expect(inner).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1 });
  });

  it('stop() detaches the listeners and restores the original send', () => {
    const { stdout, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const inner = vi.fn().mockResolvedValue(undefined);
    const transport = { send: inner };
    const { stop } = guardStdioPipe(transport, { stdout, stdin, onClientGone, log: () => undefined });

    expect(transport.send).not.toBe(inner);
    stop();
    expect(transport.send).toBe(inner);
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    stdin.emit('end');
    expect(onClientGone).not.toHaveBeenCalled();
  });
});
