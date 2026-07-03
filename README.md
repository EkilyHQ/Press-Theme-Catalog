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
node scripts/test-verify-catalog.mjs
node scripts/verify-catalog.mjs --catalog catalog.json --workspace-root .. --no-remote
node scripts/verify-catalog.mjs --catalog catalog.json --remote --verify-assets
```

The verifier checks catalog identity fields, duplicate entries, repository and
manifest URL consistency, theme-release metadata, Press engine compatibility,
local theme source inventory when available, and release ZIP size, SHA-256
digest, root folder, symlink safety, duplicate paths, file inventory, and
packaged `theme.json` metadata. Press engine ranges intentionally use the
release manifest grammar already used by official themes, such as
`>=3.4.0 <4.0.0`.

During the theme contract v4 transition the verifier accepts contracts v3 and
v4. Contract v4 releases must require Press `>=3.4.130` and their packaged
source must use runtime router href helpers instead of hardcoded public route
query strings.
