# Release SBOM

Mimir publishes a **CycloneDX 1.5** Software Bill of Materials (SBOM) for every
GitHub Release so operators can inventory npm dependencies shipped with that tag.

## What gets published

| Artifact | Location |
|----------|----------|
| CycloneDX JSON | GitHub Release asset `mimir-<tag>.cdx.json` |
| Same file | Workflow artifact `mimir-<tag>-sbom` (Actions retention) |

The SBOM is derived **only** from `package-lock.json` at the release tag. It does
not call registries, does not need production secrets, and never touches Stellar
keys, USDC rails, or deployment credentials.

## Local reproduction (clean checkout)

```bash
npm run sbom:release
# or:
node scripts/generate-release-sbom.mjs \
  --lock package-lock.json \
  --out sbom/mimir.cdx.json \
  --name mimir \
  --version 0.1.0
```

Exit code `1` means an actionable failure (missing/corrupt lockfile, unsupported
`lockfileVersion`, or an empty component set). An empty SBOM is refused
(fail-closed).

## Release workflow

`.github/workflows/release-sbom.yml` runs on `release: published`:

1. Checks out the published tag (`persist-credentials: false`).
2. Runs `scripts/generate-release-sbom.mjs` with Node 22.
3. Validates `bomFormat` and a non-empty `components` array.
4. Uploads the workflow artifact and attaches the file to the release via `gh release upload`.

### Failure / rollback

| Situation | Behavior |
|-----------|----------|
| Lockfile missing / invalid JSON | Job fails with an explicit error; release stays up without an SBOM asset |
| Zero components | Job fails (fail-closed); nothing is uploaded |
| Upload failure | Job fails; re-run the workflow or `gh release upload <tag> <file> --clobber` |
| Bad SBOM already attached | Re-run the workflow (`--clobber`) or delete the release asset manually |

Rollback does **not** affect markets, settlement, or funded-feature controls — this
pipeline only publishes dependency metadata.

## Tests

```bash
node --import tsx --test tests/node/release-sbom.test.ts
```

Coverage includes positive generation from a fixture lockfile, negative
`lockfileVersion` rejection, empty-component refusal, malformed/missing lock
errors, scoped-package purl encoding, and CLI `--out` writing.
