/**
 * A tiny counting semaphore used to cap concurrent work. Originally private to
 * grafana/client.ts (bounding outgoing Grafana HTTP requests); lifted out so
 * the screenshot-capture path can share the exact same primitive to bound
 * concurrent BrowserWindow captures (see tools/panelInvocation.ts) — a separate
 * resource that config.maxConcurrency never used to reach (see issue #96).
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
