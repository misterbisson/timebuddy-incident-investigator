# Changelog

## [0.5.0](https://github.com/misterbisson/timebuddy-incident-investigator/compare/v0.4.1...v0.5.0) (2026-07-24)


### Features

* add list_firing_alerts tool ([#141](https://github.com/misterbisson/timebuddy-incident-investigator/issues/141)) ([4790fdd](https://github.com/misterbisson/timebuddy-incident-investigator/commit/4790fdd82c7b5db6afbfcdd2df4648d3c31cf602))
* **electron:** import connections from a metadata-only JSON manifest ([#140](https://github.com/misterbisson/timebuddy-incident-investigator/issues/140)) ([030aa90](https://github.com/misterbisson/timebuddy-incident-investigator/commit/030aa900a7d38516d4d1035678e27e8fc1b58d9e))


### Bug Fixes

* **ci:** backfill release assets via gh upload, not electron-builder publish ([#135](https://github.com/misterbisson/timebuddy-incident-investigator/issues/135)) ([5c0d0f4](https://github.com/misterbisson/timebuddy-incident-investigator/commit/5c0d0f48107c271b8ba914765c5f363ce4b5b56e))
* **investigate:** make Graylog log evidence mandatory and link-traceable ([#137](https://github.com/misterbisson/timebuddy-incident-investigator/issues/137)) ([75a93ab](https://github.com/misterbisson/timebuddy-incident-investigator/commit/75a93ab81003838b461db5c71fccaa5e3d892db3))
* **investigate:** require connection-scope check before claiming blast-radius containment ([#142](https://github.com/misterbisson/timebuddy-incident-investigator/issues/142)) ([5d3ffaa](https://github.com/misterbisson/timebuddy-incident-investigator/commit/5d3ffaafcfbaaf67f1ef4aabfc430aec4448e5e8))

## [0.4.1](https://github.com/misterbisson/timebuddy-incident-investigator/compare/v0.4.0...v0.4.1) (2026-07-22)


### Bug Fixes

* publish installer assets (incl. Mac .dmg) to GitHub releases ([#133](https://github.com/misterbisson/timebuddy-incident-investigator/issues/133)) ([70b8a3d](https://github.com/misterbisson/timebuddy-incident-investigator/commit/70b8a3d2071387b0e804c398fd87a60fa37e5c65))

## [0.4.0](https://github.com/misterbisson/timebuddy-incident-investigator/compare/v0.3.0...v0.4.0) (2026-07-22)


### Features

* break out a panel by tag value (per-host GROUP BY / single-host filter) ([#130](https://github.com/misterbisson/timebuddy-incident-investigator/issues/130)) ([cf656b9](https://github.com/misterbisson/timebuddy-incident-investigator/commit/cf656b9c6c48ee41987cb4c7138a23801cb816f6))
* discover_label_values — datasource-agnostic label/tag value enumeration (Prometheus/Loki) ([#132](https://github.com/misterbisson/timebuddy-incident-investigator/issues/132)) ([f45bc25](https://github.com/misterbisson/timebuddy-incident-investigator/commit/f45bc256d6224fb7581e08ba6826db39e74fc8b3))
* enumerate InfluxDB tag values (SHOW TAG VALUES) for host/IP log-search seeds ([#128](https://github.com/misterbisson/timebuddy-incident-investigator/issues/128)) ([df13ce8](https://github.com/misterbisson/timebuddy-incident-investigator/commit/df13ce86d93af17b8c9a7dd1de15b206f610b4ec))

## [0.3.0](https://github.com/misterbisson/timebuddy-incident-investigator/compare/v0.2.0...v0.3.0) (2026-07-22)


### Features

* Graylog integration (MVP) ([#38](https://github.com/misterbisson/timebuddy-incident-investigator/issues/38)) ([75ce542](https://github.com/misterbisson/timebuddy-incident-investigator/commit/75ce54253b89ce75d1c6f9da6d681cc25115694c))
* show Graylog log searches in the Electron Activity window ([#124](https://github.com/misterbisson/timebuddy-incident-investigator/issues/124)) ([fac028d](https://github.com/misterbisson/timebuddy-incident-investigator/commit/fac028da021f4de4c73f68f3ce74bbf17022a2a6))


### Bug Fixes

* **deps:** bump fast-uri from 3.1.3 to 3.1.4 ([#114](https://github.com/misterbisson/timebuddy-incident-investigator/issues/114)) ([db04616](https://github.com/misterbisson/timebuddy-incident-investigator/commit/db04616c963e90ad1405f9162cfd85bff1b298fe))
* name dev MCP registration distinctly from packaged app ([#119](https://github.com/misterbisson/timebuddy-incident-investigator/issues/119)) ([a34d487](https://github.com/misterbisson/timebuddy-incident-investigator/commit/a34d48718f963476ddaec2a417dca88ac7b77777))
* pivot log-only findings back to find_related_dashboards in the investigate skill ([#122](https://github.com/misterbisson/timebuddy-incident-investigator/issues/122)) ([d368fb5](https://github.com/misterbisson/timebuddy-incident-investigator/commit/d368fb5578df6bb707d71e64cfc236489d2ff2ea))
* **release:** stop skipping release creation so v0.2.0 (and future) tags are cut ([#115](https://github.com/misterbisson/timebuddy-incident-investigator/issues/115)) ([1c8b228](https://github.com/misterbisson/timebuddy-incident-investigator/commit/1c8b228984b9dcd15ae9e4cb6ef31b07e13d9294))
* surface Graylog's unscoped-search permission gap, not just stream-listing ([#120](https://github.com/misterbisson/timebuddy-incident-investigator/issues/120)) ([706c90c](https://github.com/misterbisson/timebuddy-incident-investigator/commit/706c90cf4e90780d37796bdbe9714466d84b9a3e))

## [0.2.0](https://github.com/misterbisson/timebuddy-incident-investigator/compare/v0.1.0...v0.2.0) (2026-07-21)


### Features

* add Export CSV and Capture screenshot buttons to the Activity window ([#107](https://github.com/misterbisson/timebuddy-incident-investigator/issues/107)) ([4537f13](https://github.com/misterbisson/timebuddy-incident-investigator/commit/4537f1372c9f7862aacc1b507904d41fe33124ea))
* automatic version bumping and changelog generation via semantic-release ([#31](https://github.com/misterbisson/timebuddy-incident-investigator/issues/31)) ([7a8d3e9](https://github.com/misterbisson/timebuddy-incident-investigator/commit/7a8d3e9e6c13c76250605f3a0d0aa3692e25a141))
* build a scoped Electron menu, add a Connections menu item ([#23](https://github.com/misterbisson/timebuddy-incident-investigator/issues/23)) ([5206bd1](https://github.com/misterbisson/timebuddy-incident-investigator/commit/5206bd1cead9961c3e698dbf5fa70b2eda8dff06))
* rank related dashboards by recency and same-author match ([#24](https://github.com/misterbisson/timebuddy-incident-investigator/issues/24)) ([b9ecf46](https://github.com/misterbisson/timebuddy-incident-investigator/commit/b9ecf46c81492d6fb6b8e6d0603db02d1f83ecc1))
* switch release automation from semantic-release to release-please ([#55](https://github.com/misterbisson/timebuddy-incident-investigator/issues/55)) ([1c771f7](https://github.com/misterbisson/timebuddy-incident-investigator/commit/1c771f7975d1b0d08e07920513677b82883e3060))


### Bug Fixes

* align $__interval's assumed point budget with the real maxDataPoints cap ([#54](https://github.com/misterbisson/timebuddy-incident-investigator/issues/54)) ([15e2562](https://github.com/misterbisson/timebuddy-incident-investigator/commit/15e2562908bd2cae553a37dc67d4ad987eb81e1f))
* bind the webhook listener to loopback, add an optional bearer token, and tail-read the alert store ([#98](https://github.com/misterbisson/timebuddy-incident-investigator/issues/98)) ([a7f46a2](https://github.com/misterbisson/timebuddy-incident-investigator/commit/a7f46a266a1b114ab7f6574a31291fa4ba370a2d))
* bound screenshots and audit.jsonl growth in the data dir on startup ([#110](https://github.com/misterbisson/timebuddy-incident-investigator/issues/110)) ([7b124ad](https://github.com/misterbisson/timebuddy-incident-investigator/commit/7b124adf35e4ffb44495037a668bd7b4c5b2295a))
* bump release workflow to Node 24 ([#40](https://github.com/misterbisson/timebuddy-incident-investigator/issues/40)) ([56e5f7f](https://github.com/misterbisson/timebuddy-incident-investigator/commit/56e5f7fa2235203b515f889105e47a495834eaaa))
* clamp screenshot_panel width/height before they reach BrowserWindow ([#90](https://github.com/misterbisson/timebuddy-incident-investigator/issues/90)) ([045661f](https://github.com/misterbisson/timebuddy-incident-investigator/commit/045661f45b5675ec15391a6c0d445c53de4fb291))
* compute stats, runs, and excursions from the full series ([#82](https://github.com/misterbisson/timebuddy-incident-investigator/issues/82)) ([491d9d6](https://github.com/misterbisson/timebuddy-incident-investigator/commit/491d9d6c88fd87e9dc5820ea49e5a468b8bcfa74))
* dedup, stream, paginate, and atomically write the metric-index crawl ([#99](https://github.com/misterbisson/timebuddy-incident-investigator/issues/99)) ([841fad2](https://github.com/misterbisson/timebuddy-incident-investigator/commit/841fad24243b684487da021d2cb3821fe9003044))
* **deps-dev:** bump @electron/notarize from 2.5.0 to 3.1.1 ([#84](https://github.com/misterbisson/timebuddy-incident-investigator/issues/84)) ([22c0bae](https://github.com/misterbisson/timebuddy-incident-investigator/commit/22c0bae8cd7a7f276e06b62b93ee895b8b4eab9d))
* **deps-dev:** bump @types/node from 22.20.0 to 26.1.1 ([#50](https://github.com/misterbisson/timebuddy-incident-investigator/issues/50)) ([4a72907](https://github.com/misterbisson/timebuddy-incident-investigator/commit/4a72907ab40a9037e936b04fb4e68431fe441f4f))
* **deps-dev:** bump electron from 39.8.5 to 43.1.1 in /electron ([#47](https://github.com/misterbisson/timebuddy-incident-investigator/issues/47)) ([2a8f1ee](https://github.com/misterbisson/timebuddy-incident-investigator/commit/2a8f1ee930517d0287417e5f99e61da203be5e8f))
* **deps-dev:** bump tsx from 4.23.0 to 4.23.1 in the minor-and-patch group across 1 directory ([#44](https://github.com/misterbisson/timebuddy-incident-investigator/issues/44)) ([eb15bb4](https://github.com/misterbisson/timebuddy-incident-investigator/commit/eb15bb46bdc8a8eb2cb19c7f922245a80e76c29c))
* **deps-dev:** bump typescript from 5.9.3 to 7.0.2 ([#49](https://github.com/misterbisson/timebuddy-incident-investigator/issues/49)) ([17ec667](https://github.com/misterbisson/timebuddy-incident-investigator/commit/17ec6673301bc60397f1e1efe193d0cc22eb0cb4))
* **deps:** bump actions/checkout from 4 to 7 ([#43](https://github.com/misterbisson/timebuddy-incident-investigator/issues/43)) ([c15364c](https://github.com/misterbisson/timebuddy-incident-investigator/commit/c15364c27269f2b5c667ead13a7871ba9f69fd39))
* **deps:** bump actions/setup-node from 4 to 7 ([#42](https://github.com/misterbisson/timebuddy-incident-investigator/issues/42)) ([7334a37](https://github.com/misterbisson/timebuddy-incident-investigator/commit/7334a37fdb1435bfad4b18dc801e7353290b7803))
* **deps:** bump googleapis/release-please-action from 4 to 5 ([#57](https://github.com/misterbisson/timebuddy-incident-investigator/issues/57)) ([10ab81b](https://github.com/misterbisson/timebuddy-incident-investigator/commit/10ab81b97502d276177fa1f9dc9a5c38480ec399))
* **deps:** bump undici from 7.28.0 to 8.7.0 ([#48](https://github.com/misterbisson/timebuddy-incident-investigator/issues/48)) ([46d2fcd](https://github.com/misterbisson/timebuddy-incident-investigator/commit/46d2fcde2956a78c24a41ced646de918774fe5a1))
* **deps:** bump undici from 8.7.0 to 8.8.0 in the minor-and-patch group ([#100](https://github.com/misterbisson/timebuddy-incident-investigator/issues/100)) ([2afd562](https://github.com/misterbisson/timebuddy-incident-investigator/commit/2afd56209100c36610383307578c1ca7f293e26f))
* **deps:** bump zod from 3.25.76 to 4.4.3 ([#101](https://github.com/misterbisson/timebuddy-incident-investigator/issues/101)) ([9dc2dda](https://github.com/misterbisson/timebuddy-incident-investigator/commit/9dc2dda58e2cf133854093f332409494452dbfff))
* error when a hint URL matches no configured connection ([#83](https://github.com/misterbisson/timebuddy-incident-investigator/issues/83)) ([bde3b75](https://github.com/misterbisson/timebuddy-incident-investigator/commit/bde3b75aa6beff0ee41d4a5b71d173c02e40208e))
* honor matchHosts in the Electron live-view auth guard, under the connection's own scheme ([#103](https://github.com/misterbisson/timebuddy-incident-investigator/issues/103)) ([673e355](https://github.com/misterbisson/timebuddy-incident-investigator/commit/673e355d1b0635068525e343879b67c0cfd6b90e))
* isolate connection secret failures and write the store atomically ([#93](https://github.com/misterbisson/timebuddy-incident-investigator/issues/93)) ([8f5640b](https://github.com/misterbisson/timebuddy-incident-investigator/commit/8f5640bfcdaa34c1a46c0c3909083b29c7cad7a3))
* neutralize Grafana-captured CSV exports against spreadsheet formula injection ([#104](https://github.com/misterbisson/timebuddy-incident-investigator/issues/104)) ([f8843ad](https://github.com/misterbisson/timebuddy-incident-investigator/commit/f8843ad01b56d5d6e135980190d299ff13904196))
* neutralize leading whitespace only when a formula character follows ([#106](https://github.com/misterbisson/timebuddy-incident-investigator/issues/106)) ([#112](https://github.com/misterbisson/timebuddy-incident-investigator/issues/112)) ([309a9c7](https://github.com/misterbisson/timebuddy-incident-investigator/commit/309a9c760825e4a65d2f8eabc815ebf1d97c07ad))
* neutralize this server's own CSV exports against spreadsheet formula injection ([#92](https://github.com/misterbisson/timebuddy-incident-investigator/issues/92)) ([61e9488](https://github.com/misterbisson/timebuddy-incident-investigator/commit/61e948816a5d333a6095e129597a2cfad5c073c9))
* only read the Grafana InfluxQL query mode that's actually active ([#36](https://github.com/misterbisson/timebuddy-incident-investigator/issues/36)) ([6e0f0c7](https://github.com/misterbisson/timebuddy-incident-investigator/commit/6e0f0c716e66dd449ff57f739bdbb3e809d0523e))
* parse Grafana 11 scenes panel URLs (viewPanel=panel-3) ([#80](https://github.com/misterbisson/timebuddy-incident-investigator/issues/80)) ([aeac7bc](https://github.com/misterbisson/timebuddy-incident-investigator/commit/aeac7bcc98b67e053a7b0dd26fb1de8d8e45c319))
* pass an explicit key schema to every z.record() call ([#105](https://github.com/misterbisson/timebuddy-incident-investigator/issues/105)) ([6317a50](https://github.com/misterbisson/timebuddy-incident-investigator/commit/6317a50bda1a2ad55b1e8dc8e7a9c07362a9adfc))
* pin Dependabot commit-message prefix so titles match semantic-release ([#51](https://github.com/misterbisson/timebuddy-incident-investigator/issues/51)) ([82306eb](https://github.com/misterbisson/timebuddy-incident-investigator/commit/82306eb4d99e0b45086fd0c9532fbdfd6e416ad9))
* redact tool error paths ([#88](https://github.com/misterbisson/timebuddy-incident-investigator/issues/88)) ([35c5d29](https://github.com/misterbisson/timebuddy-incident-investigator/commit/35c5d2908055600d428717fdbd847f0dede27c30))
* release Dependabot dependency bumps, not just feat/fix commits ([#41](https://github.com/misterbisson/timebuddy-incident-investigator/issues/41)) ([e90cef7](https://github.com/misterbisson/timebuddy-incident-investigator/commit/e90cef7ae09d117aa77ba4c1f11ca377798e28b5))
* treat an all-zero baseline as a presence change, not a 1e8-sigma anomaly ([#89](https://github.com/misterbisson/timebuddy-incident-investigator/issues/89)) ([58d3252](https://github.com/misterbisson/timebuddy-incident-investigator/commit/58d3252f9722f00d95195823be04723335ada98d))
