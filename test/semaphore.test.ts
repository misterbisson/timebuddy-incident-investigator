import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/util/semaphore.js';

/** A controllable unit of work: marks itself running, then blocks until released. */
function makeWorkload(sem: Semaphore) {
  const state = { running: 0, peak: 0 };
  const holds: Array<() => void> = [];
  const start = () =>
    sem.run(() => {
      state.running++;
      state.peak = Math.max(state.peak, state.running);
      return new Promise<void>((resolve) => {
        holds.push(() => {
          state.running--;
          resolve();
        });
      });
    });
  const releaseOne = () => holds.shift()?.();
  return { state, start, releaseOne, pending: () => holds.length };
}

const flush = async () => {
  // Several microtask hops so a released slot's finally + the woken waiter's
  // continuation both settle before we assert.
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('Semaphore', () => {
  it('admits up to max concurrently and queues the rest', async () => {
    const sem = new Semaphore(2);
    const { state, start } = makeWorkload(sem);
    const runs = [start(), start(), start(), start()];
    await flush();
    expect(state.running).toBe(2);
    expect(state.peak).toBe(2);
    void runs;
  });

  it('does not exceed max when a newcomer races a slot handoff (issue #151)', async () => {
    // max=1. The bug: a finishing task decrements `active` and wakes the queued
    // waiter, but a fresh caller arriving between that decrement and the
    // waiter's re-increment sees a free slot and is admitted too — two run at
    // once. Slot-transfer admission keeps `active` pinned so the newcomer queues.
    const sem = new Semaphore(1);
    const { state, start, releaseOne } = makeWorkload(sem);

    const p1 = start(); // admitted, running = 1
    const p2 = start(); // queued
    await flush();
    expect(state.running).toBe(1);

    releaseOne(); // p1 finishes -> hands its slot to p2
    await Promise.resolve(); // let p1's finally / handoff run, before the newcomer
    const p3 = start(); // newcomer races in right after the handoff
    await flush();

    // With the old decrement-then-wake semaphore, p2 and p3 both ran here.
    expect(state.peak).toBe(1);

    releaseOne();
    await flush();
    releaseOne();
    await flush();
    await Promise.all([p1, p2, p3]);
    expect(state.peak).toBe(1);
  });

  it('runs every task eventually and settles active back to zero', async () => {
    const sem = new Semaphore(3);
    const { state, start, releaseOne, pending } = makeWorkload(sem);
    const runs = Array.from({ length: 10 }, () => start());
    // Drain: repeatedly release the oldest in-flight task until none remain.
    for (let i = 0; i < 10; i++) {
      await flush();
      releaseOne();
    }
    await flush();
    await Promise.all(runs);
    expect(state.running).toBe(0);
    expect(state.peak).toBe(3);
    expect(pending()).toBe(0);
  });
});
