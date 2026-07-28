# Changelog

## [0.3.1](https://github.com/openbydesign/lush/compare/v0.3.0...v0.3.1) (2026-07-28)


### Bug Fixes

* **release:** publish images under repository owner ([#96](https://github.com/openbydesign/lush/issues/96)) ([791d4ae](https://github.com/openbydesign/lush/commit/791d4ae5c5700eae16b92287e5be45df020e90b5))

## [0.3.0](https://github.com/openbydesign/lush/compare/v0.2.0...v0.3.0) (2026-07-28)


### Features

* **inference:** improve enumeration & capabilities ([#94](https://github.com/openbydesign/lush/issues/94)) ([de49f9a](https://github.com/openbydesign/lush/commit/de49f9a6363db8af2622ca09884da2762671a71c))


### Bug Fixes

* **code:** remove the --token argv fallback ([#93](https://github.com/openbydesign/lush/issues/93)) ([a862e9a](https://github.com/openbydesign/lush/commit/a862e9a15c63b400693424a6e8f6ac4fa8d1a842))


### Performance Improvements

* **code:** reuse the harness probe from session start ([#92](https://github.com/openbydesign/lush/issues/92)) ([e5bb1a8](https://github.com/openbydesign/lush/commit/e5bb1a85252b92ad68e4a5b98ef41affd10b63ae))

## [0.2.0](https://github.com/lush-agents/lush/compare/v0.1.2...v0.2.0) (2026-07-20)


### Features

* **api:** authenticate dynamic proxy gateways ([#87](https://github.com/lush-agents/lush/issues/87)) ([a2eff42](https://github.com/lush-agents/lush/commit/a2eff425e73b2ef5dbc9d31777cab0857f1db9f8))

## [0.1.2](https://github.com/lush-agents/lush/compare/v0.1.1...v0.1.2) (2026-07-20)


### Bug Fixes

* **release:** stage assets before immutable publication ([#84](https://github.com/lush-agents/lush/issues/84)) ([79041d5](https://github.com/lush-agents/lush/commit/79041d5c57aad527115f0e4c8c7887a2f44007b3))

## [0.1.1](https://github.com/lush-agents/lush/compare/v0.1.0...v0.1.1) (2026-07-20)


### Bug Fixes

* **notifications:** use Bun-compatible SMTP client ([#82](https://github.com/lush-agents/lush/issues/82)) ([30d635f](https://github.com/lush-agents/lush/commit/30d635f6a681730ee925fdf3cf6f915591c63df5))

## 0.1.0 (2026-07-18)


### ⚠ BREAKING CHANGES

* **web:** lush-web no longer proxies /health or /v1beta paths. Same-origin deployments must route those paths directly to lush-api at ingress; LUSH_API_UPSTREAM and LUSH_EXTERNAL_SCHEME are removed from the web-image contract.

### Features

* **release:** publish signed static web distribution ([#75](https://github.com/lush-agents/lush/issues/75)) ([1084819](https://github.com/lush-agents/lush/commit/1084819cb6f382c8c9124d7f4c529a4512d55401))
* **release:** publish versioned container images ([#46](https://github.com/lush-agents/lush/issues/46)) ([0137f0d](https://github.com/lush-agents/lush/commit/0137f0d82b618486ab08458a0618ed093105dd51))
* **web:** make lush-web a topology-neutral static origin ([#74](https://github.com/lush-agents/lush/issues/74)) ([5c0810d](https://github.com/lush-agents/lush/commit/5c0810d15f3df0bc8142b876a8fb00a2030244a0))


### Performance Improvements

* **code:** append session events incrementally ([#76](https://github.com/lush-agents/lush/issues/76)) ([c652546](https://github.com/lush-agents/lush/commit/c6525465437c1e50256a0ed403bd2a3350f106a9)), closes [#20](https://github.com/lush-agents/lush/issues/20)
