# Releases

Lush has one product version for the repository. Internal workspace packages
remain private implementation units and are not versioned or published
independently.

## Versioning policy

Lush follows Semantic Versioning with `vMAJOR.MINOR.PATCH` Git tags.

- Before `1.0.0`, incompatible changes increment `MINOR`. New backwards-
  compatible functionality also increments `MINOR`, and fixes increment
  `PATCH`.
- After `1.0.0`, incompatible changes increment `MAJOR`, backwards-compatible
  functionality increments `MINOR`, and fixes increment `PATCH`.
- A version covers the API, database migrations, browser app, and all other
  source in this repository as one tested release.
- The public `/v1beta` API may evolve incompatibly during the pre-1.0 period.
  Stable API surfaces need their own compatibility policy before promotion to
  `/v1`.

The root `package.json` is the source version. The workspace package versions
are deliberately not release coordinates.

Lush is distributed under the repository's Apache License 2.0.

## Release process

Release Please maintains one release pull request from Conventional Commit
messages on `main`:

- `fix:` proposes a patch release;
- `feat:` proposes a minor release;
- a `BREAKING CHANGE:` footer or `!` proposes an incompatible release;
- other commit types are included as appropriate but do not independently
  force a version bump.

Merging the release pull request updates `package.json` and `CHANGELOG.md`,
creates the matching `vMAJOR.MINOR.PATCH` tag, and creates a draft GitHub
Release. The same workflow validates that tag, attaches the static browser
distribution, publishes both OCI images, and only then publishes the GitHub
Release. Repositories with immutable releases enabled require this ordering:
published releases cannot accept new or replacement assets.

Add a fine-grained `RELEASE_PLEASE_TOKEN` Actions secret with repository
Contents and Pull requests write access. Release Please uses this token so its
pull request triggers the normal test and image-build workflows; GitHub
suppresses workflows caused by pull requests created with the repository
`GITHUB_TOKEN`. The repository-level **Allow GitHub Actions to create and
approve pull requests** setting applies to `GITHUB_TOKEN` and can remain
disabled.

Image publication uses the repository-scoped `GITHUB_TOKEN`, so no registry
credential is required. Before publishing, the workflow confirms that the
requested immutable tag resolves to the checked-out commit and reruns the repo
checks and complete test suite against that exact source. Both pull-request CI
and release validation provision PostgreSQL and set `LUSH_TEST_DATABASE_URL`,
so database-backed auth and migration integration tests are part of the release
gate. Integration suites fail during discovery when `CI=true` and that dedicated
database URL is absent; they cannot silently degrade to skipped tests.

Before the first public release:

1. Add `RELEASE_PLEASE_TOKEN` and require the test, image-build, and
   `Build lush-web distribution` checks on the release pull request.
2. Confirm the two GHCR packages inherit public visibility from this public
   repository, or make them public after their first publication.

If artifact or image publication fails, the GitHub Release remains a draft;
rerun the failed workflow jobs before publishing it. The `Publish images`
workflow also accepts the same existing release tag as a manual recovery path.
Dispatch both the workflow and its input at that tag so the artifact and
attestation provenance identify the same commit:

```sh
gh workflow run publish-images.yml --ref v0.1.0 -f ref=v0.1.0
```

Manual publication fails before building if the workflow's `GITHUB_SHA` differs
from the requested tag commit. A release tag must never move to another commit.

## Published artifacts

Each release publishes multi-platform `linux/amd64` and `linux/arm64` images:

- `ghcr.io/openbydesign/lush-api:<version>`
- `ghcr.io/openbydesign/lush-web:<version>`

Stable releases also update `latest`. Prereleases do not. Production and
managed deployments should pin an exact version or, preferably, the published
digest; `latest` is for evaluation only.

Every published image uses digest-pinned base images and has OCI source,
version, and revision metadata plus a GitHub/Sigstore build-provenance
attestation.

The same release also attaches a static browser distribution for CDN, object
storage, and other static hosting:

- `lush-web-dist-<version>.tar.gz`
- `lush-web-dist-<version>.tar.gz.sha256`
- `lush-web-dist-<version>.intoto.jsonl`

The archive is built from the tagged checkout with the locked Bun dependencies
used by the web image. Its root `lush-manifest.json` records the Lush version and
full Git revision, and `runtime-config.js` is the empty same-origin placeholder.

Download and verify all three assets before extracting the archive:

```sh
version=0.1.0
gh release download "v$version" \
  --repo openbydesign/lush \
  --pattern "lush-web-dist-$version*"
source_digest="$(gh api "repos/openbydesign/lush/commits/v$version" --jq .sha)"
sha256sum --check "lush-web-dist-$version.tar.gz.sha256"
gh attestation verify "lush-web-dist-$version.tar.gz" \
  --repo openbydesign/lush \
  --bundle "lush-web-dist-$version.intoto.jsonl" \
  --source-digest "$source_digest" \
  --signer-workflow openbydesign/lush/.github/workflows/publish-images.yml
gh attestation verify "lush-web-dist-$version.tar.gz.sha256" \
  --repo openbydesign/lush \
  --bundle "lush-web-dist-$version.intoto.jsonl" \
  --source-digest "$source_digest" \
  --signer-workflow openbydesign/lush/.github/workflows/publish-images.yml
```

Changing either the archive or checksum makes this sequence fail. The checksum
binds the downloaded filename and bytes, while the signed provenance binds both
files to the repository, tagged commit, and release workflow. The attestation's
source ref is the `main` caller workflow ref, so verification deliberately pins
the commit resolved from the immutable release tag instead.

## Release scope

The release workflow publishes only artifacts that are real deployment units
today. The API currently embeds the agent runtime, so there is no standalone
`lush-agent` image. Add a separately versioned image only when that service is
actually split across a network boundary.
