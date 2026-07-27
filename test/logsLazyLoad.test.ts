import { describe, expect, it, vi } from 'vitest';

// Finding #146: correlate.ts and joinShape.ts sit on the static import chain
// every server startup runs (registerAll.ts -> tools/correlateLogs.ts ->
// here), unconditionally, unlike the screenshotter tool which is gated
// behind a runtime check. Before the fix, both files imported their
// @liquescent package as a plain top-level value import, so a missing or
// broken install of that *optional* companion package would throw at
// module-evaluation time and crash the entire MCP server - not just disable
// correlate_logs - the moment registerAll.ts's import chain reached them.
//
// vi.doMock's factory throwing simulates "this package fails to resolve."
// Merely *loading* correlate.ts/joinShape.ts must not touch it - only
// actually calling their exported functions should.
describe('correlate.ts / joinShape.ts defer their @liquescent import past module load', () => {
  it('loads correlate.ts without touching @liquescent/log-correlator-core', async () => {
    vi.resetModules();
    vi.doMock('@liquescent/log-correlator-core', () => {
      throw new Error('@liquescent/log-correlator-core should not be imported at module load time');
    });

    await expect(import('../src/logs/correlate.js')).resolves.toBeDefined();

    // The mocked factory throwing only surfaces once the dynamic import
    // inside correlateLogs() actually runs - proving the module load above
    // didn't touch it. (vitest wraps the factory's own error message, so
    // just assert the call rejects rather than matching its exact text.)
    const { correlateLogs } = await import('../src/logs/correlate.js');
    await expect(
      correlateLogs({
        client: { searchAbsolute: vi.fn(), listStreams: vi.fn() } as never,
        query: 'graylog(service:x)[5m]',
        fromMs: 0,
        toMs: 1,
        limit: 10,
      }),
    ).rejects.toThrow();

    vi.doUnmock('@liquescent/log-correlator-core');
    vi.resetModules();
  });

  it('loads joinShape.ts without touching @liquescent/log-correlator-query-parser', async () => {
    vi.resetModules();
    vi.doMock('@liquescent/log-correlator-query-parser', () => {
      throw new Error('@liquescent/log-correlator-query-parser should not be imported at module load time');
    });

    await expect(import('../src/logs/joinShape.js')).resolves.toBeDefined();

    // joinShape() itself never throws (best-effort parse, see its own doc
    // comment) - but a mock-import failure inside it is exactly the kind of
    // unparseable-query case that falls back to the undefined/[] shape, so
    // this still proves the import was deferred to the call, not module load.
    const { joinShape } = await import('../src/logs/joinShape.js');
    await expect(joinShape('graylog(service:x)[5m]')).resolves.toEqual({ joinType: undefined, rightSelectors: [] });

    vi.doUnmock('@liquescent/log-correlator-query-parser');
    vi.resetModules();
  });
});
