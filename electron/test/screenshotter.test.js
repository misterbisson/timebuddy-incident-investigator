// Exercises the real capturePanel() against a real (offscreen) BrowserWindow —
// the scale-factor compensation added for #179 can't be verified against a
// mock, since the whole point is that Electron's actual capturePage()/toPNG()
// bakes the host display's device pixels into the image. On a 1x display
// (most CI runners) the compensation is a no-op, so this only actually
// exercises the fix on hi-dpi dev hardware — but the assertion holds either
// way: the backing store this call allocates should track the requested
// width/height, not the requested size times scaleFactor^2. Run with:
//   electron test/screenshotter.test.js --user-data-dir=<dir>
const assert = require('node:assert');
const { app, screen } = require('electron');

app.whenReady().then(async () => {
  try {
    const { createScreenshotter } = require('../src/screenshotter.js');
    const screenshotter = createScreenshotter();

    const requested = { width: 1600, height: 900 };
    const result = await screenshotter.capturePanel({
      url: 'data:text/html,<html><body style="margin:0;background:red;width:100vw;height:100vh"></body></html>',
      headers: {},
      width: requested.width,
      height: requested.height,
      timeoutMs: 10_000,
    });

    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    const requestedArea = requested.width * requested.height;
    const capturedArea = result.width * result.height;

    console.log(
      `scaleFactor=${scaleFactor} requested=${requested.width}x${requested.height} ` +
        `captured=${result.width}x${result.height}`,
    );

    // Without the scaleFactor compensation, capturedArea would be
    // requestedArea * scaleFactor^2 (e.g. 4x on a 2x Retina display) — the
    // exact backing-store blowup #179 exists to close. Some rounding slop is
    // expected from dividing then re-multiplying by scaleFactor, so this
    // checks the capture landed near the *requested* area, not near
    // requestedArea * scaleFactor^2.
    assert.ok(
      capturedArea <= requestedArea * 1.1,
      `captured area ${capturedArea} should stay close to the requested ${requestedArea} ` +
        `(scaleFactor=${scaleFactor}), not blow up by scaleFactor^2`,
    );
    assert.ok(
      capturedArea >= requestedArea * 0.85,
      `captured area ${capturedArea} should not be needlessly smaller than the requested ${requestedArea}`,
    );

    console.log('screenshotter.test.js: PASS');
    app.quit();
  } catch (err) {
    console.error('screenshotter.test.js: FAIL', err);
    app.exit(1);
  }
});
