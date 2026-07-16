#!/usr/bin/env node
// Keeps electron/package.json's version in lockstep with the root package,
// since @semantic-release/npm only bumps the root package.json.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: sync-electron-version.js <version>');
  process.exit(1);
}

const path = new URL('../electron/package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(path, 'utf8'));
pkg.version = version;
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
