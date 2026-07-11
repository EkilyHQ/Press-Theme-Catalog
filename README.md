# Press Theme Catalog

Browser-readable official theme catalog for Press Theme Manager.

Press loads `catalog.json` from:

```text
https://raw.githubusercontent.com/EkilyHQ/Press-Theme-Catalog/main/catalog.json
```

Each entry points to a theme repository root `theme-release.json`; the release
manifest remains the source of truth for version, contract version, ZIP URL,
size, digest, and file inventory.

## Verification

Catalog changes must pass the official theme verifier before merge:

```bash
export NODE_AUTH_TOKEN=<token with read:packages for @ekilyhq/press-theme-contract>
npm ci --ignore-scripts
npm test
npm run quality
npm run verify
node scripts/verify-catalog.mjs --catalog catalog.json --workspace-root .. --no-remote --press-version 3.4.130
```

The verifier checks catalog identity fields, duplicate entries, repository and
manifest URL consistency, theme-release metadata, Press engine compatibility,
local theme source inventory when available, and release ZIP size, SHA-256
digest, root folder, symlink safety, duplicate paths, file inventory, and
packaged `theme.json` metadata. Press engine ranges intentionally use the
release manifest grammar already used by official themes, such as
`>=3.4.0 <4.0.0`.

Contract v4 route-helper source scanning is delegated to the Press-owned
`@ekilyhq/press-theme-contract` package. Catalog owns official release and ZIP
distribution checks; it does not vendor route-analysis logic.

Code Quality CI pins Node 22.18.0 and applies ESLint's recommended rules with
zero warnings, forbids source-level ESLint configuration comments, and runs a
full-repository Prettier check. The current type-checking
decision and its mandatory revisit trigger are recorded in
`scripts/code-quality-policy.json`.
