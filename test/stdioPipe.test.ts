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
  return { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() };
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
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockResolvedValue(undefined) };
    guardStdioPipe(transport, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    // Would throw (uncaught exception) if the guard hadn't attached a listener.
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'write-failed', error: expect.any(Error) });
  });

  it('treats stdin EOF as the client being gone', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    stdin.emit('end');
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'stdin-closed', error: undefined });
  });

  it('reports the client gone at most once, however many signals arrive', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    stdin.emit('end');
    stdout.emit('error', epipe());
    stdout.emit('error', epipe());
    expect(onClientGone).toHaveBeenCalledTimes(1);
  });

  it('handles a non-disconnect stdout error without crashing or claiming the client left', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, onClientGone, log });

    expect(() => stdout.emit('error', new Error('disk on fire'))).not.toThrow();
    expect(onClientGone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk on fire'));
  });

  it('resolves rather than rejecting when send rejects with a disconnect', async () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockRejectedValue(epipe()) };
    guardStdioPipe(transport, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).resolves.toBeUndefined();
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'write-failed', error: expect.any(Error) });
  });

  it('resolves when send throws a disconnect synchronously', async () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = {
      send: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
      }),
    };
    guardStdioPipe(transport, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).resolves.toBeUndefined();
    expect(onClientGone).toHaveBeenCalledTimes(1);
  });

  it('leaves genuine send failures alone — only pipe death is swallowed', async () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const transport = { send: vi.fn().mockRejectedValue(new Error('message too large')) };
    guardStdioPipe(transport, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    await expect(transport.send()).rejects.toThrow('message too large');
    expect(onClientGone).not.toHaveBeenCalled();
  });

  it('passes successful sends straight through, arguments intact', async () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const inner = vi.fn().mockResolvedValue(undefined);
    const transport = { send: inner };
    guardStdioPipe(transport, { stdout, stderr, stdin, log: () => undefined });

    await expect(transport.send({ jsonrpc: '2.0', id: 1 } as never)).resolves.toBeUndefined();
    expect(inner).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1 });
  });

  it('stop() detaches the listeners and restores the original send', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const inner = vi.fn().mockResolvedValue(undefined);
    const transport = { send: inner };
    const { stop } = guardStdioPipe(transport, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    expect(transport.send).not.toBe(inner);
    stop();
    expect(transport.send).toBe(inner);
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    stdin.emit('end');
    expect(onClientGone).not.toHaveBeenCalled();
  });
});

/**
 * #252. These are the regression tests for the half of the fault that shipped
 * unguarded: stderr is a pipe to the same parent as stdout, so it dies at the
 * same moment, and every diagnostic this process writes goes there. Unhandled,
 * that write is an uncaught exception whose host handler writes to stderr
 * again — a loop, not a crash. One orphan span 14h45m at ~97% of a core.
 */
describe('guardStdioPipe: the stderr half (#252)', () => {
  it('does not let an EPIPE on stderr go unhandled', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, log: () => undefined });

    // Emitting 'error' on a listener-less EventEmitter throws — which is
    // precisely the uncaught exception that fed the loop.
    expect(() => stderr.emit('error', epipe())).not.toThrow();
  });

  it('treats a dead stderr as the client being gone, same as a dead stdout', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, onClientGone, log: () => undefined });

    stderr.emit('error', epipe());
    expect(onClientGone).toHaveBeenCalledWith({ reason: 'write-failed', error: expect.any(Error) });
  });

  it('handles a non-disconnect stderr error without claiming the client left', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const onClientGone = vi.fn();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, onClientGone, log });

    expect(() => stderr.emit('error', new Error('disk on fire'))).not.toThrow();
    expect(onClientGone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stderr'));
  });

  it('names which stream failed, so the log line is diagnosable', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, log });

    stdout.emit('error', new Error('nope'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('writing to stdout'));
  });

  it('stop() detaches the stderr listener too', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const guard = guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, log: () => undefined });

    guard.stop();
    expect(stderr.listenerCount('error')).toBe(0);
  });
});

/**
 * The other half of #252: the guard's own reporting was the ignition source.
 * reportClientGone() logs "the client is gone" — to the pipe that just proved
 * it — and in the Electron host that write re-enters the uncaughtException
 * handler. One final line is worth attempting (stdin-closed leaves stderr
 * perfectly writable); everything after it is writing into the void.
 */
describe('guardStdioPipe: goes quiet once the client is gone', () => {
  it('logs the client-gone line itself, then nothing further', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, log });

    stdin.emit('end');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('MCP client is gone'));

    // A late non-disconnect error on a departed pipe: previously logged, which
    // is a write to a dead stderr for no reader's benefit.
    stderr.emit('error', new Error('disk on fire'));
    stdout.emit('error', new Error('disk on fire'));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stays silent even under the repeated errors that made this a loop', () => {
    const { stdout, stderr, stdin } = fakeStreams();
    const log = vi.fn();
    guardStdioPipe({ send: vi.fn().mockResolvedValue(undefined) }, { stdout, stderr, stdin, log });

    stderr.emit('error', epipe());
    for (let i = 0; i < 1000; i++) stderr.emit('error', epipe());
    expect(log).toHaveBeenCalledTimes(1);
  });
});
