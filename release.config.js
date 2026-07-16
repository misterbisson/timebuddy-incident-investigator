// No @semantic-release/github plugin: electron-builder's own --publish step
// (release.yml) already creates the GitHub release and uploads platform
// installers once it builds against the tag this config creates. Adding the
// github plugin here would create a second, asset-less release for the same
// tag before that job even runs.
import conventionalChangelogAngular from 'conventional-changelog-angular';

// commit-analyzer's default preset (Angular, since no `preset` is set below)
// only bumps a version for `feat`/`fix`/`perf`/breaking/revert commits.
// Dependabot's auto-generated titles — `build(deps): ...` / `build(deps-dev):
// ...` for a single-dependency PR, `chore(deps): ...` for a grouped one (see
// .github/dependabot.yml) — don't match any of those, so without this,
// merging a Dependabot PR (including a security fix) produces no version
// bump and, because release.yml's build job only runs `if:
// needs.version.outputs.published == 'true'`, no new signed build at all —
// the fix never reaches electron-updater. `deps-dev` is covered too, not
// just `deps`: `electron` itself lives in devDependencies but is the actual
// runtime bundled into the shipped app by electron-builder.
const dependencyReleaseRules = [
  { type: 'build', scope: 'deps', release: 'patch' },
  { type: 'build', scope: 'deps-dev', release: 'patch' },
  { type: 'chore', scope: 'deps', release: 'patch' },
  { type: 'chore', scope: 'deps-dev', release: 'patch' },
];

// release-notes-generator uses the same default Angular preset for its
// CHANGELOG.md writer, whose `transform` unconditionally discards any
// non-breaking commit that isn't feat/fix/perf/revert — so even once the
// releaseRules above make a dependency-bump commit trigger a release, its
// CHANGELOG.md entry would otherwise be silently empty. Delegate to Angular's
// own transform first and only override the cases it discards.
const { writer: angularWriterOpts } = await conventionalChangelogAngular();
function transform(commit, context) {
  const transformed = angularWriterOpts.transform(commit, context);
  if (transformed !== undefined) return transformed;
  const isDependencyCommit =
    (commit.type === 'build' || commit.type === 'chore') && (commit.scope === 'deps' || commit.scope === 'deps-dev');
  if (isDependencyCommit) {
    return { ...commit, type: 'Dependencies' };
  }
  return undefined;
}

export default {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', { releaseRules: dependencyReleaseRules }],
    ['@semantic-release/release-notes-generator', { writerOpts: { transform } }],
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
