/**
 * A tiny counting semaphore that caps concurrent async work at `max`.
 *
 * Shared by GrafanaClient and GraylogClient — each constructs its own instance,
 * so their concurrency limits stay independent, but the admission logic lives
 * in one place rather than a copy per client, so it can't drift between them
 * (the two copies previously drifting is exactly how the over-admission bug
 * could be fixed in one and missed in the other — issue #151).
 *
 * Admission is slot-transfer, not decrement-then-wake. When a task finishes it
 * hands its slot straight to the next queued waiter — `active` is left
 * unchanged and the woken waiter does NOT re-increment. The naive version
 * (decrement `active`, then wake a waiter that re-increments after its await)
 * briefly drops `active` below the true in-flight count: a fresh caller
 * arriving in that window sees a free slot and is admitted alongside the woken
 * waiter, so `max + 1` run at once. Transferring the slot closes the window —
 * the count never dips below the real occupancy, so a newcomer racing a wake-up
 * is still made to queue.
 */
export class Semaphore {
  private readonly queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    // Queued. Our slot is granted by release(), which hands it over WITHOUT
    // decrementing `active` — so the finishing task's slot is already ours and
    // we must not increment on wake.
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Transfer this slot to the waiter: `active` is unchanged (one task left,
      // one admitted), which is what keeps the count from dipping and letting a
      // newcomer slip in over the cap.
      next();
    } else {
      this.active--;
    }
  }
}
