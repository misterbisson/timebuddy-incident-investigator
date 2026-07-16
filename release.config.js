// No @semantic-release/github plugin: electron-builder's own --publish step
// (release.yml) already creates the GitHub release and uploads platform
// installers once it builds against the tag this config creates. Adding the
// github plugin here would create a second, asset-less release for the same
// tag before that job even runs.
export default {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // npmPublish stays false: nothing here publishes to the npm registry today,
    // this just gives us the version bump in package.json/package-lock.json.
    ['@semantic-release/npm', { npmPublish: false }],
    // @semantic-release/npm only bumps the root package.json — electron/package.json
    // (the version electron-builder actually ships) needs to match it.
    ['@semantic-release/exec', { prepareCmd: 'node scripts/sync-electron-version.js ${nextRelease.version}' }],
    ['@semantic-release/git', {
      assets: ['package.json', 'package-lock.json', 'electron/package.json', 'CHANGELOG.md'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }],
  ],
};
