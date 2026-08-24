# Changelog

## [0.4.0](https://github.com/openbydesign/lush/compare/v0.3.1...v0.4.0) (2026-08-24)


### Features

* **agent:** add remote sandbox isolation provider ([#115](https://github.com/openbydesign/lush/issues/115)) ([1fe1cf3](https://github.com/openbydesign/lush/commit/1fe1cf32461a57038d178a47d3f118f36a685fb0))
* **agent:** durable Lush runs ([#105](https://github.com/openbydesign/lush/issues/105)) ([a3f36cd](https://github.com/openbydesign/lush/commit/a3f36cd04ce3cb904f8a0c0d81a43377d4a75ed6))
* **inf:** openai compat api & token mgmt ([#114](https://github.com/openbydesign/lush/issues/114)) ([77e0c40](https://github.com/openbydesign/lush/commit/77e0c40201d2b6e5a7ce4ccbb545910286fb52ad))
* **tools,agent:** tool gateway and AX-aligned agent runtime foundations ([#101](https://github.com/openbydesign/lush/issues/101)) ([e9339bf](https://github.com/openbydesign/lush/commit/e9339bf461994056a063d09ad78788d174a50bda))
* **tools:** complete Phase 2 control plane ([#108](https://github.com/openbydesign/lush/issues/108)) ([61aa199](https://github.com/openbydesign/lush/commit/61aa1997480b24c3b70b5489bccd527ad136dc58))
* **tools:** composer ux and tool wiring ([#112](https://github.com/openbydesign/lush/issues/112)) ([5fe0009](https://github.com/openbydesign/lush/commit/5fe0009192f69d63c3a0447e781ae4a545c1c8f1))


### Bug Fixes

* **api:** bound graceful shutdown time ([#99](https://github.com/openbydesign/lush/issues/99)) ([aa1ff66](https://github.com/openbydesign/lush/commit/aa1ff66e23d4b805f3c02e13c7062f0f758d9f1b))
* **app:** portal confirmation dialogs ([#110](https://github.com/openbydesign/lush/issues/110)) ([ace2bf4](https://github.com/openbydesign/lush/commit/ace2bf4f041e5a84dc29280bd84a41a76a0fda00))
* **ui:** app ui look and feel improvements ([#113](https://github.com/openbydesign/lush/issues/113)) ([9057b1b](https://github.com/openbydesign/lush/commit/9057b1b0b812ee47df53004a5c0a4d84d1ea22e5))


### Performance Improvements

* **code:** poll the session event cursor ([#91](https://github.com/openbydesign/lush/issues/91)) ([ebc159f](https://github.com/openbydesign/lush/commit/ebc159f8ddc8c5fda0f08f2a7d787b07d258a793))

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
