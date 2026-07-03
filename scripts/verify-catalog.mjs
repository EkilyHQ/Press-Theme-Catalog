#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_PRESS_RELEASE_URL = 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/system-release.json';
const DEFAULT_OWNER = 'EkilyHQ';
const SUPPORTED_THEME_CONTRACT_VERSIONS = new Set([2, 3]);
const THEME_CONTRACT_V3_MIN_PRESS_VERSION = '3.4.127';
const THEME_CONTRACT_V3_PREVIOUS_PRESS_VERSION = '3.4.126';

export async function verifyCatalog(options = {}) {
  const catalogPath = options.catalogPath || path.resolve('catalog.json');
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : '';
  const remote = options.remote !== false;
  const verifyAssets = options.verifyAssets === true;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const pressVersion = await resolvePressVersion({
    pressVersion: options.pressVersion,
    workspaceRoot,
    pressReleaseUrl: options.pressReleaseUrl || DEFAULT_PRESS_RELEASE_URL,
    fetchImpl
  });
  const catalog = await readJsonFile(catalogPath);
  const failures = [];
  if (!pressVersion) {
    failures.push('Press version could not be resolved; pass --press-version or make the Press system release reachable');
  }
  validateCatalog(catalog, failures);

  const entries = Array.isArray(catalog.themes) ? catalog.themes : [];
  for (const entry of entries) {
    await verifyCatalogEntry(entry, {
      failures,
      workspaceRoot,
      remote,
      verifyAssets,
      fetchImpl,
      pressVersion
    });
  }

  return {
    ok: failures.length === 0,
    catalogPath,
    pressVersion,
    checkedThemes: entries.length,
    failures
  };
}

async function verifyCatalogEntry(entry, context) {
  const slug = stringValue(entry.value);
  if (!slug) return;
  const label = stringValue(entry.label);
  const repo = stringValue(entry.repo);
  const expectedRepo = expectedThemeRepo(slug);
  const manifestUrl = stringValue(entry.manifestUrl);
  const expectedManifestUrl = `https://raw.githubusercontent.com/${repo}/main/theme-release.json`;

  if (repo !== expectedRepo) {
    context.failures.push(`${slug}: repo must be ${expectedRepo}`);
  }
  if (manifestUrl !== expectedManifestUrl) {
    context.failures.push(`${slug}: manifestUrl must be ${expectedManifestUrl}`);
  }
  if (label && label !== titleFromSlug(slug)) {
    context.failures.push(`${slug}: label must be ${titleFromSlug(slug)}`);
  }

  const release = await loadThemeRelease(entry, context);
  if (!release) return;
  validateThemeRelease(entry, release, context);

  const localTheme = await loadLocalTheme(entry, context.workspaceRoot);
  if (localTheme) {
    validateLocalTheme(entry, release, localTheme, context.failures);
  }

  if (context.verifyAssets) {
    await verifyThemeAsset(entry, release, context);
  }
}

function validateCatalog(catalog, failures) {
  if (!catalog || typeof catalog !== 'object') {
    failures.push('catalog must be a JSON object');
    return;
  }
  if (catalog.schemaVersion !== 1) {
    failures.push('catalog.schemaVersion must be 1');
  }
  if (!Array.isArray(catalog.themes) || catalog.themes.length === 0) {
    failures.push('catalog.themes must be a non-empty array');
    return;
  }

  const seen = {
    value: new Set(),
    label: new Set(),
    repo: new Set(),
    manifestUrl: new Set()
  };
  catalog.themes.forEach((entry, index) => {
    const prefix = `themes[${index}]`;
    if (!entry || typeof entry !== 'object') {
      failures.push(`${prefix}: entry must be an object`);
      return;
    }
    ['value', 'label', 'repo', 'manifestUrl'].forEach((field) => {
      const value = stringValue(entry[field]);
      if (!value) {
        failures.push(`${prefix}.${field} must be a non-empty string`);
      } else if (seen[field].has(value)) {
        failures.push(`${prefix}.${field} duplicates ${value}`);
      } else {
        seen[field].add(value);
      }
    });
    if (entry.description != null && !stringValue(entry.description)) {
      failures.push(`${prefix}.description must be a non-empty string when present`);
    }
  });
}

async function loadThemeRelease(entry, context) {
  const slug = stringValue(entry.value);
  const repoName = repoShortName(entry.repo);
  const localPath = context.workspaceRoot && repoName
    ? path.join(context.workspaceRoot, repoName, 'theme-release.json')
    : '';
  if (localPath && existsSync(localPath)) {
    return readJsonFile(localPath);
  }
  if (!context.remote) {
    context.failures.push(`${slug}: local theme-release.json not found at ${localPath || '(no workspace root)'}`);
    return null;
  }
  try {
    return await readJsonUrl(stringValue(entry.manifestUrl), context.fetchImpl);
  } catch (error) {
    context.failures.push(`${slug}: failed to fetch theme-release.json: ${error.message}`);
    return null;
  }
}

async function loadLocalTheme(entry, workspaceRoot) {
  const repoName = repoShortName(entry.repo);
  const themePath = workspaceRoot && repoName
    ? path.join(workspaceRoot, repoName, 'theme', 'theme.json')
    : '';
  if (!themePath || !existsSync(themePath)) return null;
  const themeJson = await readJsonFile(themePath);
  const themeDir = path.dirname(themePath);
  return {
    themeJson,
    files: await listThemeFiles(themeDir)
  };
}

function validateThemeRelease(entry, release, context) {
  const slug = stringValue(entry.value);
  const label = stringValue(entry.label);
  if (!release || typeof release !== 'object') {
    context.failures.push(`${slug}: theme-release must be an object`);
    return;
  }
  if (release.schemaVersion !== 1) context.failures.push(`${slug}: release schemaVersion must be 1`);
  if (release.type !== 'press-theme') context.failures.push(`${slug}: release type must be press-theme`);
  if (release.value !== slug) context.failures.push(`${slug}: release value must match catalog`);
  if (release.label !== label) context.failures.push(`${slug}: release label must match catalog`);
  if (!isSemver(release.version)) context.failures.push(`${slug}: release version must be semver`);
  if (!SUPPORTED_THEME_CONTRACT_VERSIONS.has(release.contractVersion)) {
    context.failures.push(`${slug}: release contractVersion must be supported`);
  }
  const pressRange = stringValue(release.engines && release.engines.press);
  if (!pressRange) {
    context.failures.push(`${slug}: release engines.press is required`);
  } else if (context.pressVersion && !satisfiesSemverRange(context.pressVersion, pressRange)) {
    context.failures.push(`${slug}: release engines.press (${pressRange}) does not accept Press ${context.pressVersion}`);
  }
  if (release.contractVersion === 3 && pressRange) {
    validateV3PressRange(slug, pressRange, context.failures);
  }
  if (!Array.isArray(release.files) || release.files.length === 0) {
    context.failures.push(`${slug}: release files must be a non-empty array`);
  } else {
    validateFileInventory(`${slug}: release files`, release.files, context.failures);
  }
  validateReleaseAsset(entry, release, context.failures);
}

function validateV3PressRange(slug, pressRange, failures) {
  if (!satisfiesSemverRange(THEME_CONTRACT_V3_MIN_PRESS_VERSION, pressRange)
    || satisfiesSemverRange(THEME_CONTRACT_V3_PREVIOUS_PRESS_VERSION, pressRange)) {
    failures.push(`${slug}: contract v3 engines.press must start at Press ${THEME_CONTRACT_V3_MIN_PRESS_VERSION} or later`);
  }
}

function validateLocalTheme(entry, release, localTheme, failures) {
  const slug = stringValue(entry.value);
  const theme = localTheme.themeJson;
  if (theme.name !== release.label) failures.push(`${slug}: theme/theme.json name must match release label`);
  if (theme.version !== release.version) failures.push(`${slug}: theme/theme.json version must match release version`);
  if (theme.contractVersion !== release.contractVersion) failures.push(`${slug}: theme/theme.json contractVersion must match release`);
  if (stringValue(theme.engines && theme.engines.press) !== stringValue(release.engines && release.engines.press)) {
    failures.push(`${slug}: theme/theme.json engines.press must match release`);
  }
  const expected = normalizeFiles(release.files || []);
  const actual = normalizeFiles(localTheme.files || []);
  if (!sameArray(expected, actual)) {
    failures.push(`${slug}: local theme/ file inventory must match theme-release files`);
  }
  const declaredFiles = [
    ...(Array.isArray(theme.styles) ? theme.styles : []),
    ...(Array.isArray(theme.modules) ? theme.modules : [])
  ];
  declaredFiles.forEach((file) => {
    if (!actual.includes(file)) failures.push(`${slug}: theme/theme.json declares missing file ${file}`);
  });
}

function validateReleaseAsset(entry, release, failures) {
  const slug = stringValue(entry.value);
  const version = stringValue(release.version);
  const asset = release.asset && typeof release.asset === 'object' ? release.asset : null;
  if (!asset) {
    failures.push(`${slug}: release asset is required`);
    return;
  }
  const expectedName = `press-theme-${slug}-v${version}.zip`;
  if (asset.name !== expectedName) failures.push(`${slug}: asset.name must be ${expectedName}`);
  const expectedUrl = `https://raw.githubusercontent.com/${entry.repo}/release-artifacts/v${version}/${expectedName}`;
  if (asset.url !== expectedUrl && !String(asset.url || '').startsWith('file://')) {
    failures.push(`${slug}: asset.url must be ${expectedUrl}`);
  }
  if (!Number.isInteger(asset.size) || asset.size <= 0) {
    failures.push(`${slug}: asset.size must be a positive integer`);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(stringValue(asset.digest))) {
    failures.push(`${slug}: asset.digest must be a sha256 digest`);
  }
}

async function verifyThemeAsset(entry, release, context) {
  const slug = stringValue(entry.value);
  const asset = release.asset || {};
  try {
    const bytes = await readUrlBuffer(asset.url, context.fetchImpl);
    if (bytes.length !== asset.size) {
      context.failures.push(`${slug}: asset size ${bytes.length} does not match ${asset.size}`);
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== asset.digest) {
      context.failures.push(`${slug}: asset digest ${digest} does not match ${asset.digest}`);
    }
    const inventory = await inspectZip(bytes, `press-theme-${slug}`);
    inventory.failures.forEach((failure) => context.failures.push(`${slug}: ${failure}`));
    if (!inventory.failures.length) {
      const expected = normalizeFiles(release.files || []);
      const actual = normalizeFiles(inventory.files);
      const duplicateZipFiles = duplicateValues(inventory.files);
      if (duplicateZipFiles.length) {
        context.failures.push(`${slug}: ZIP inventory must not contain duplicate paths: ${duplicateZipFiles.join(', ')}`);
      }
      if (!sameArray(expected, actual)) {
        context.failures.push(`${slug}: ZIP file inventory must match theme-release files`);
      }
      if (!actual.includes('theme.json')) {
        context.failures.push(`${slug}: ZIP inventory must include theme.json`);
      }
      if (inventory.themeJson) {
        validateThemeManifest(`${slug}: ZIP theme.json`, entry, release, inventory.themeJson, actual, context.failures);
      } else if (actual.includes('theme.json')) {
        context.failures.push(`${slug}: ZIP theme.json must be valid JSON`);
      }
    }
  } catch (error) {
    context.failures.push(`${slug}: failed to verify asset: ${error.message}`);
  }
}

async function inspectZip(bytes, expectedRoot) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'press-theme-catalog-'));
  const zipPath = path.join(tempDir, 'theme.zip');
  try {
    await writeFile(zipPath, bytes);
    const names = runUnzip(['-Z1', zipPath]);
    const lines = runUnzip(['-Z', '-l', zipPath]).split(/\r?\n/u);
    const failures = [];
    const entries = names.split(/\r?\n/u).filter(Boolean);
    const rootPrefix = `${expectedRoot}/`;
    entries.forEach((entry) => {
      if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')) {
        failures.push(`ZIP entry has unsafe path ${entry}`);
      }
      if (!entry.startsWith(rootPrefix)) {
        failures.push(`ZIP entry ${entry} must live under ${rootPrefix}`);
      }
    });
    lines.forEach((line) => {
      if (/^l[-rwx]/u.test(line.trim())) {
        failures.push('ZIP must not contain symlinks');
      }
    });
    const roots = new Set(entries.map((entry) => entry.split('/')[0]).filter(Boolean));
    if (roots.size !== 1 || !roots.has(expectedRoot)) {
      failures.push(`ZIP must contain only root folder ${expectedRoot}`);
    }
    let themeJson = null;
    if (entries.includes(`${expectedRoot}/theme.json`)) {
      try {
        themeJson = JSON.parse(runUnzip(['-p', zipPath, `${expectedRoot}/theme.json`]));
      } catch {
        themeJson = null;
      }
    }
    return {
      failures,
      files: entries
        .filter((entry) => entry.startsWith(rootPrefix) && !entry.endsWith('/'))
        .map((entry) => entry.slice(rootPrefix.length)),
      themeJson
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function runUnzip(args) {
  const result = spawnSync('unzip', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'unzip failed').trim());
  }
  return result.stdout;
}

async function listThemeFiles(themeDir) {
  const files = [];
  async function walk(dir, prefix = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await walk(themeDir);
  return files.sort();
}

async function resolvePressVersion({ pressVersion, workspaceRoot, pressReleaseUrl, fetchImpl }) {
  if (pressVersion) return pressVersion;
  const localPressSystem = workspaceRoot ? path.join(workspaceRoot, 'Press', 'assets', 'press-system.json') : '';
  if (localPressSystem && existsSync(localPressSystem)) {
    const pressSystem = await readJsonFile(localPressSystem);
    return stringValue(pressSystem.version);
  }
  try {
    const release = await readJsonUrl(pressReleaseUrl, fetchImpl);
    return stringValue(release.version);
  } catch {
    return '';
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonUrl(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function readUrlBuffer(url, fetchImpl = globalThis.fetch) {
  const value = stringValue(url);
  if (value.startsWith('file://')) {
    return readFile(fileURLToPath(value));
  }
  const response = await fetchImpl(value);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

function validateFileInventory(label, files, failures) {
  const normalized = normalizeFiles(files);
  if (normalized.length !== files.length) failures.push(`${label} must not contain duplicate paths`);
  normalized.forEach((file) => {
    if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      failures.push(`${label} contains unsafe path ${file}`);
    }
  });
  if (!normalized.includes('theme.json')) failures.push(`${label} must include theme.json`);
}

function validateThemeManifest(label, entry, release, theme, inventory, failures) {
  const slug = stringValue(entry.value);
  if (!theme || typeof theme !== 'object') {
    failures.push(`${label} must be an object`);
    return;
  }
  if (theme.name !== release.label) failures.push(`${label} name must match release label`);
  if (theme.version !== release.version) failures.push(`${label} version must match release version`);
  if (theme.contractVersion !== release.contractVersion) failures.push(`${label} contractVersion must match release`);
  if (stringValue(theme.engines && theme.engines.press) !== stringValue(release.engines && release.engines.press)) {
    failures.push(`${label} engines.press must match release`);
  }
  const declaredFiles = [
    ...validatedStringArray(`${label} styles`, theme.styles, failures),
    ...validatedStringArray(`${label} modules`, theme.modules, failures)
  ];
  if (!Array.isArray(theme.modules) || theme.modules.length === 0) {
    failures.push(`${label} modules must be a non-empty array`);
  }
  declaredFiles.forEach((file) => {
    if (!inventory.includes(file)) failures.push(`${slug}: theme.json declares missing file ${file}`);
  });
}

function validatedStringArray(label, value, failures) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array when present`);
    return [];
  }
  const normalized = normalizeFiles(value);
  if (normalized.length !== value.length) failures.push(`${label} must not contain duplicate or empty paths`);
  normalized.forEach((file) => {
    if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      failures.push(`${label} contains unsafe path ${file}`);
    }
  });
  return normalized;
}

function expectedThemeRepo(slug) {
  return `${DEFAULT_OWNER}/Press-Theme-${titleFromSlug(slug)}`;
}

function repoShortName(repo) {
  const parts = stringValue(repo).split('/');
  return parts.length === 2 ? parts[1] : '';
}

function titleFromSlug(slug) {
  return stringValue(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFiles(files) {
  return [...new Set((Array.isArray(files) ? files : []).map(stringValue).filter(Boolean))].sort();
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  (Array.isArray(values) ? values : []).map(stringValue).filter(Boolean).forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  });
  return [...duplicates].sort();
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(stringValue(value));
}

function parseSemver(value) {
  const match = stringValue(value).match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return NaN;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesSemverRange(version, range) {
  const clauses = stringValue(range).split('||').map((part) => part.trim()).filter(Boolean);
  if (!clauses.length) return false;
  return clauses.some((clause) => clause.split(/\s+/u).filter(Boolean).every((token) => {
    const match = token.match(/^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/u);
    if (!match) return false;
    const compare = compareSemver(version, match[2]);
    if (!Number.isFinite(compare)) return false;
    const op = match[1] || '=';
    if (op === '>=') return compare >= 0;
    if (op === '>') return compare > 0;
    if (op === '<=') return compare <= 0;
    if (op === '<') return compare < 0;
    return compare === 0;
  }));
}

function parseArgs(argv) {
  const options = {
    catalogPath: 'catalog.json',
    workspaceRoot: '',
    remote: true,
    verifyAssets: false,
    pressVersion: '',
    pressReleaseUrl: DEFAULT_PRESS_RELEASE_URL
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--catalog') options.catalogPath = argv[++index];
    else if (arg === '--workspace-root') options.workspaceRoot = argv[++index];
    else if (arg === '--no-remote') options.remote = false;
    else if (arg === '--remote') options.remote = true;
    else if (arg === '--verify-assets') options.verifyAssets = true;
    else if (arg === '--press-version') options.pressVersion = argv[++index];
    else if (arg === '--press-release-url') options.pressReleaseUrl = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`usage: node scripts/verify-catalog.mjs [options]

Options:
  --catalog <path>             Catalog JSON path (default: catalog.json)
  --workspace-root <path>      Optional Ekily workspace root for local theme repo checks
  --remote                    Fetch missing theme-release manifests from manifestUrl (default)
  --no-remote                 Do not fetch remote manifests
  --verify-assets             Download theme ZIPs and verify size, digest, root, and file inventory
  --press-version <version>    Explicit Press version for engines.press checks
  --press-release-url <url>    Press system-release URL used when version is not local
`);
}

async function main() {
  const result = await verifyCatalog(parseArgs(process.argv.slice(2)));
  if (!result.ok) {
    console.error(`catalog verification failed with ${result.failures.length} issue(s):`);
    result.failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(`ok - verified ${result.checkedThemes} official themes for Press ${result.pressVersion || 'unknown'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
