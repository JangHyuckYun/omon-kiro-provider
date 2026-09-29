# Changelog

## 0.3.0-native.3 - 2026-09-29

### Changed

- Renamed this fork to `omon-kiro-provider` (package name, GitHub repository,
  install references, log prefixes). GitHub redirects the old
  `JangHyuckYun/pi-kiro-provider` URL.
- Engine patch artifact names (`*.pi-kiro-provider.backup`, `.receipt.json`,
  `.lock`) are unchanged so existing patched installs keep their rollback path.
- Provider ID stays `kiro`; model references such as `kiro/claude-opus-5.5`
  are unchanged.

## 0.3.0-native.2 - 2026-09-29

### Changed

- Corrected the README host support table: only macOS has end-to-end
  verification; Linux is supported by path rules but not yet run-verified.
- Install references now point to `v0.3.0-native.2`. Provider code is
  unchanged from `0.3.0-native.1`.

## 0.3.0-native.1 - 2026-09-29

OMO Native 5.1 hardened fork release.

### Added

- `claude-opus-5.5` model metadata: 1M context, 128K output, 2.0x credits.
- Native `max` thinking metadata and Kiro-wide default `compactionTriggerRatio: 0.8`.
- Fail-closed OMO Native engine setup/check/restore workflow with version and fingerprint gates.
- Native compatibility regression coverage for schema, stream, tools, history, abort, diagnostics, retry, and compaction boundaries.
- Korean fork status, installation, update, rollback, and verification documentation.

### Fixed

- Top-level tool schema combinators rejected by Kiro.
- JSON-array tool payloads and malformed event-stream prefix recovery.
- Interleaved tool block ordering and buffered usage double counting.
- Mixed assistant text/tool history and truncated conversation identity.
- Cross-provider pipe-compound tool IDs.
- Stalled payload/response hooks and provider abort provenance.
- Native provider diagnostics, custom provider IDs, and Retry-After markers.
- Transient Kiro 429 recovery before Native cools the only credential slot,
  with bounded abortable exponential retry and configurable limits.
- Kiro API-key `tokentype` header handling.
- Optional OAuth registration for current Native package APIs.

### Compatibility

- Engine patch profile: `omo-ai@5.1.0`, `@code-yeongyu/senpi@2026.9.28-7`.
- The npm `pi-kiro-provider` package remains the upstream project; install this fork by Git URL.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-07-03

### Changed
- Widened Pi peer dependency ranges to 0.80 and added security dependency overrides. ([ce50099](https://github.com/MasuRii/pi-kiro-provider/commit/ce50099c1071da42f69a2c637bf124ea4634ff12))
- Extracted shared credentials and HTTP utilities to reduce duplication. ([1c2fbe3](https://github.com/MasuRii/pi-kiro-provider/commit/1c2fbe34689f92794bff56ca7f4fc372fcf69b16))

## [0.2.1] - 2026-06-16

### Fixed
- Validated that parsed model cost values are non-negative finite numbers to prevent invalid cost metadata from silently passing through.
- Added stricter bounds checking for malformed event stream frames, returning `null` instead of silently reading past the header section boundary.

## [0.2.0] - 2026-06-01

### Added
- Added lazy loading for Kiro OAuth and streaming modules to reduce startup cost.

### Changed
- Widened Pi peer dependency compatibility to include Pi 0.77.x and 0.78.x.

### Fixed
- Corrected the default Kiro API key placeholder to reference `$KIRO_ACCESS_TOKEN` consistently in config and docs.

## [0.1.0] - 2026-05-27

### Added
- Prepared npm/GitHub release metadata, package contents, README, changelog, license, and package ignore rules for public review.
- Added the initial Kiro provider extension with OAuth registration, Pi provider registration, runtime provider replay for pi-multi-auth, configurable model metadata, and file-gated debug logging.
