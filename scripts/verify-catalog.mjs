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
const SUPPORTED_THEME_CONTRACT_VERSIONS = new Set([3, 4]);
const THEME_CONTRACT_V3_MIN_PRESS_VERSION = '3.4.127';
const THEME_CONTRACT_V4_MIN_PRESS_VERSION = '3.4.130';
const STRING_LITERAL_PATTERN = /(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gu;
const ROUTE_QUERY_PATTERN = /[?&]([^=&#\s]+)\s*=/gu;
const ROUTE_KEY_OBJECT_INIT_PATTERN = /(?:^|[,{]\s*)(?:(['"`])(?:tab|id)\1|(?:tab|id))\s*:/u;
const ROUTE_KEY_OBJECT_SHORTHAND_PATTERN = /(?:^|[,{]\s*)(?:tab|id)\s*(?=[,}])/u;
const ROUTE_KEY_ARRAY_INIT_PATTERN = /\[\s*(['"`])(?:tab|id)\1\s*,/u;
const SPLIT_ROUTE_QUERY_LITERAL_PATTERN = /(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?[?&])\1\s*\+\s*(?:\(\s*)*(?:(['"`])(?:tab|id)\s*=|(['"`])(?:tab|id)\4\s*\+\s*(?:\(\s*)*(['"`])=\5)/gu;
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/u;
const MEMBER_EXPRESSION_PATTERN_SOURCE = `(?:this|${IDENTIFIER_PATTERN.source})(?:\\s*\\.\\s*${IDENTIFIER_PATTERN.source})+`;
const STATIC_MEMBER_STRING_PATTERN_SOURCE = `(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\`(?:\\\\[\\s\\S]|[^\`\\\\])*\`)`;
const STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE = `(?:${IDENTIFIER_PATTERN.source}|${STATIC_MEMBER_STRING_PATTERN_SOURCE}|\\[\\s*${STATIC_MEMBER_STRING_PATTERN_SOURCE}\\s*\\])`;
const MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE = `(?:this|${IDENTIFIER_PATTERN.source})(?:(?:\\s*\\.\\s*${IDENTIFIER_PATTERN.source})|(?:\\s*\\[\\s*${STATIC_MEMBER_STRING_PATTERN_SOURCE}\\s*\\]))+`;
const ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE = `(?:"(?:tab|id)"|'(?:tab|id)'|\`(?:tab|id)\`)`;
const URL_CONSTRUCTOR_PATTERN_SOURCE = `(?:URL|(?:window|globalThis)\\s*\\.\\s*URL)`;

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
  if (release.contractVersion === 4 && pressRange) {
    validateV4PressRange(slug, pressRange, context.failures);
  }
  if (!Array.isArray(release.files) || release.files.length === 0) {
    context.failures.push(`${slug}: release files must be a non-empty array`);
  } else {
    validateFileInventory(`${slug}: release files`, release.files, context.failures);
  }
  validateReleaseAsset(entry, release, context.failures);
}

function validateV3PressRange(slug, pressRange, failures) {
  if (semverRangeAllowsBefore(pressRange, THEME_CONTRACT_V3_MIN_PRESS_VERSION)) {
    failures.push(`${slug}: contract v3 engines.press must not accept Press versions before ${THEME_CONTRACT_V3_MIN_PRESS_VERSION}`);
  }
}

function validateV4PressRange(slug, pressRange, failures) {
  if (semverRangeAllowsBefore(pressRange, THEME_CONTRACT_V4_MIN_PRESS_VERSION)) {
    failures.push(`${slug}: contract v4 engines.press must not accept Press versions before ${THEME_CONTRACT_V4_MIN_PRESS_VERSION}`);
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
    const inventory = await inspectZip(bytes, `press-theme-${slug}`, { scanRouteLiterals: release.contractVersion === 4 });
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
      if (release.contractVersion === 4 && inventory.routeLiteralFiles.length) {
        context.failures.push(`${slug}: contract v4 ZIP packaged source must use router href helpers instead of public route literals in ${inventory.routeLiteralFiles.join(', ')}`);
      }
    }
  } catch (error) {
    context.failures.push(`${slug}: failed to verify asset: ${error.message}`);
  }
}

async function inspectZip(bytes, expectedRoot, options = {}) {
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
    const files = entries
      .filter((entry) => entry.startsWith(rootPrefix) && !entry.endsWith('/'))
      .map((entry) => entry.slice(rootPrefix.length));
    const routeLiteralFiles = [];
    const routeLiteralSources = [];
    if (options.scanRouteLiterals) {
      for (const file of files) {
        if (!shouldScanForPublicRouteLiterals(file)) continue;
        try {
          const contents = runUnzip(['-p', zipPath, `${expectedRoot}/${file}`]);
          routeLiteralSources.push({ file, contents });
        } catch (error) {
          failures.push(`ZIP source file ${file} could not be scanned: ${error.message}`);
        }
      }
      routeLiteralSources.forEach(({ file, contents }) => {
        if (containsForbiddenV4RouteConstruction(
          contents,
          {
            path: file,
            files: routeLiteralSources.map((entry) => ({ path: entry.file, source: entry.contents }))
          }
        )) routeLiteralFiles.push(file);
      });
    }
    return {
      failures,
      files,
      themeJson,
      routeLiteralFiles
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function shouldScanForPublicRouteLiterals(file) {
  const normalized = stringValue(file).toLowerCase();
  if (!normalized || normalized === 'theme.json') return false;
  return /\.(?:html?|js|mjs|svg)$/u.test(normalized);
}

function isExternalUrlPrefix(value) {
  const prefix = stringValue(value);
  return /^[a-z][a-z0-9+.-]*:/i.test(prefix) || prefix.startsWith('//');
}

function decodeUrlQueryKey(value) {
  const text = stringValue(value).trim();
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

function routeQueryKeyIsForbidden(value) {
  return /^(?:tab|id)$/u.test(decodeUrlQueryKey(value));
}

function routeCandidatePrefix(content, queryIndex) {
  const before = String(content || '').slice(0, queryIndex);
  const boundaries = ['"', "'", '`', ' ', '\n', '\r', '\t', '(', '[', '{', '=', '>'];
  let boundary = -1;
  boundaries.forEach((candidate) => {
    const index = before.lastIndexOf(candidate);
    if (index > boundary) boundary = index;
  });
  return before.slice(boundary + 1).trim();
}

function stripWrappingParentheses(value) {
  let text = stringValue(value).trim();
  let changed = true;
  while (changed && text.startsWith('(') && text.endsWith(')')) {
    changed = false;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i === text.length - 1) {
          text = text.slice(1, -1).trim();
          changed = true;
          break;
        }
        if (depth === 0) break;
      }
    }
  }
  return text;
}

function routeGuardPreviousTokenAllowsRegex(source, index) {
  const text = String(source || '');
  let i = index - 1;
  while (i >= 0 && /\s/u.test(text[i])) i -= 1;
  if (i < 0) return true;
  const ch = text[i];
  if (/[({\[=,:;!?&|+*%~^<>-]/u.test(ch)) return true;
  const word = text.slice(0, i + 1).match(/([A-Za-z_$][\w$]*)$/u);
  return Boolean(word && /^(?:return|throw|case|typeof|delete|void|new|yield|await|else|do|in|instanceof)$/u.test(word[1]));
}

function routeGuardRegexLiteralEnd(source, start) {
  const text = String(source || '');
  let escaped = false;
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[A-Za-z]/u.test(text[end] || '')) end += 1;
      return end;
    }
    if (ch === '\n' || ch === '\r') return start + 1;
  }
  return start + 1;
}

function stripCommentsForRouteGuard(source) {
  const text = String(source || '');
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next !== '/' && next !== '*' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      const end = routeGuardRegexLiteralEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length) {
        const blockCh = text[i + 1];
        const blockNext = text[i + 2] || '';
        if (blockCh === '*' && blockNext === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += blockCh === '\n' || blockCh === '\r' ? blockCh : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '<' && text.slice(i, i + 4) === '<!--') {
      out += '    ';
      i += 3;
      while (i + 1 < text.length) {
        if (text.slice(i + 1, i + 4) === '-->') {
          out += '   ';
          i += 3;
          break;
        }
        const htmlCh = text[i + 1];
        out += htmlCh === '\n' || htmlCh === '\r' ? htmlCh : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function maskNonCodeForRouteGuard(source) {
  const text = String(source || '');
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      out += ch === '\n' || ch === '\r' ? ch : ' ';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ' ';
      continue;
    }
    if (ch === '/' && next !== '/' && next !== '*' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      const end = routeGuardRegexLiteralEnd(text, i);
      out += text.slice(i, end).replace(/[^\n\r]/gu, ' ');
      i = end - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length) {
        const blockCh = text[i + 1];
        const blockNext = text[i + 2] || '';
        if (blockCh === '*' && blockNext === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += blockCh === '\n' || blockCh === '\r' ? blockCh : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function stripHtmlCommentsForRouteGuard(source) {
  return String(source || '').replace(/<!--[\s\S]*?-->/gu, (match) => (
    match.replace(/[^\n\r]/gu, ' ')
  ));
}

function containsRelativePressRouteLiteral(content) {
  const value = String(content || '');
  ROUTE_QUERY_PATTERN.lastIndex = 0;
  let match = ROUTE_QUERY_PATTERN.exec(value);
  while (match) {
    if (!routeQueryKeyIsForbidden(match[1])) {
      match = ROUTE_QUERY_PATTERN.exec(value);
      continue;
    }
    const queryIndex = match[0].startsWith('?')
      ? match.index
      : value.lastIndexOf('?', match.index);
    const prefix = queryIndex >= 0 ? routeCandidatePrefix(value, queryIndex) : '';
    if (!isExternalUrlPrefix(prefix)) return true;
    match = ROUTE_QUERY_PATTERN.exec(value);
  }
  return false;
}

function stringLiteralIsExternalUrlConstructorArg(source, literalMatch, externalAliases = new Set()) {
  const text = String(source || '');
  const before = text.slice(0, literalMatch.index);
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const callMatch = before.match(new RegExp(`\\bnew\\s+(?:${constructorPattern})\\s*\\(\\s*(?:\\(\\s*)*$`, 'u'));
  if (!callMatch) return false;
  const callPrefixIndex = before.length - callMatch[0].length;
  const argsStart = callPrefixIndex + callMatch[0].indexOf('(') + 1;
  const parsed = extractCallArgs(text, argsStart);
  const parts = splitTopLevelArgs(parsed.args);
  return parts.length > 1
    && expressionIsStaticRelativeUrl(parts[0])
    && expressionIsExternalUrl(parts[1], externalAliases);
}

function containsForbiddenRouteLiteral(source, externalAliases = new Set()) {
  const text = String(source || '');
  STRING_LITERAL_PATTERN.lastIndex = 0;
  let match = STRING_LITERAL_PATTERN.exec(text);
  while (match) {
    if (containsRelativePressRouteLiteral(decodeJsStringLiteralContent(match[2]))
      && !stringLiteralIsExternalUrlConstructorArg(text, match, externalAliases)
      && !stringLiteralHasExternalRouteContext(text, match, externalAliases)) {
      return true;
    }
    match = STRING_LITERAL_PATTERN.exec(text);
  }
  return false;
}

function containsForbiddenHtmlRouteAttribute(source) {
  const text = String(source || '');
  const re = /\b(?:href|src|srcset|action|poster|formaction|cite|data-[a-z0-9_-]*href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>]+))/giu;
  let match = re.exec(text);
  while (match) {
    const value = match[1] || match[2] || match[3] || '';
    if (containsRelativePressRouteLiteral(decodeHtmlAttributeValue(value))) return true;
    match = re.exec(text);
  }
  return false;
}

function decodeHtmlAttributeValue(value) {
  return String(value || '')
    .replace(/&#(x[0-9a-f]+|\d+);?/giu, (_, raw) => {
      const code = raw.toLowerCase().startsWith('x')
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&(?:amp|equals|quest);?/giu, (entity) => {
      const key = entity.replace(/[&;]/g, '').toLowerCase();
      if (key === 'amp') return '&';
      if (key === 'equals') return '=';
      if (key === 'quest') return '?';
      return entity;
    });
}

function decodeJsStringLiteralContent(value) {
  return String(value || '')
    .replace(/\\u\{([0-9a-f]+)\}/giu, (_, raw) => {
      const code = Number.parseInt(raw, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/\\u([0-9a-f]{4})/giu, (_, raw) => String.fromCharCode(Number.parseInt(raw, 16)))
    .replace(/\\x([0-9a-f]{2})/giu, (_, raw) => String.fromCharCode(Number.parseInt(raw, 16)))
    .replace(/\\([\\'"`?&=])/gu, '$1');
}

function splitTopLevelConcatParts(value) {
  const text = String(value || '');
  const out = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0 && ch === '+') {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

function staticStringExpressionValue(expression) {
  const text = stripWrappingParentheses(expression);
  const literal = text.match(/^(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1$/u);
  if (literal) {
    if (literal[1] === '`' && /\$\{/u.test(literal[2])) return null;
    return decodeJsStringLiteralContent(literal[2]);
  }
  const parts = splitTopLevelConcatParts(text);
  if (parts.length < 2) return null;
  let value = '';
  for (const part of parts) {
    const partValue = staticStringExpressionValue(part);
    if (partValue == null) return null;
    value += partValue;
  }
  return value;
}

function normalizeStaticMemberExpression(expression) {
  const value = String(expression || '').trim();
  const root = value.match(new RegExp(`^(?:this|${IDENTIFIER_PATTERN.source})`, 'u'));
  if (!root) return value;
  const parts = [root[0]];
  const tokenRe = new RegExp(`\\s*(?:\\.\\s*(${IDENTIFIER_PATTERN.source})|\\[\\s*(${STATIC_MEMBER_STRING_PATTERN_SOURCE})\\s*\\])`, 'yu');
  let index = root[0].length;
  while (index < value.length) {
    tokenRe.lastIndex = index;
    const token = tokenRe.exec(value);
    if (!token) return value;
    const property = token[1] || staticStringExpressionValue(token[2]);
    if (!new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(property || '')) return value;
    parts.push(property);
    index = tokenRe.lastIndex;
  }
  return parts.join('.');
}

function normalizeStaticObjectPropertyKey(key) {
  const text = String(key || '').trim();
  let value = '';
  if (new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(text)) {
    value = text;
  } else if (text.startsWith('[') && text.endsWith(']')) {
    value = staticStringExpressionValue(text.slice(1, -1));
  } else {
    value = staticStringExpressionValue(text);
  }
  return new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(value || '') ? value : '';
}

function collectDestructuredStaticPropertyAliases(body, property) {
  const text = String(body || '');
  const out = new Set();
  const escaped = escapeRe(property);
  const aliasRe = new RegExp(`(?:^|,)\\s*${escaped}\\s*:\\s*(${IDENTIFIER_PATTERN.source})(?:\\s*=\\s*[^,}]*)?`, 'gu');
  let alias = aliasRe.exec(text);
  while (alias) {
    out.add(alias[1]);
    alias = aliasRe.exec(text);
  }
  const computedAliasRe = new RegExp(`(?:^|,)\\s*\\[\\s*(${STATIC_MEMBER_STRING_PATTERN_SOURCE})\\s*\\]\\s*:\\s*(${IDENTIFIER_PATTERN.source})(?:\\s*=\\s*[^,}]*)?`, 'gu');
  alias = computedAliasRe.exec(text);
  while (alias) {
    if (staticStringExpressionValue(alias[1]) === property) out.add(alias[2]);
    alias = computedAliasRe.exec(text);
  }
  const shorthandRe = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:=\\s*[^,}]*)?(?:,|$)`, 'u');
  if (shorthandRe.test(text)) out.add(property);
  return out;
}

function collectStaticStringAliases(source, expectedValue) {
  const text = String(source || '');
  const aliases = new Set();
  const re = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*`, 'gu');
  let match = re.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, re.lastIndex);
    if (staticStringExpressionValue(expression) === expectedValue
      && (match[1] === 'const' || !bindingIsReassigned(text, match[2], re.lastIndex + expression.length))) {
      aliases.add(match[2]);
    }
    re.lastIndex += expression.length;
    match = re.exec(text);
  }
  return aliases;
}

function shouldScanHtmlRouteAttributes(path, source) {
  const clean = String(path || '').toLowerCase();
  if (/\.(?:html?|svg)$/iu.test(clean)) return true;
  if (clean) return false;
  return /<\s*[a-z][\s\S]*?\b(?:href|src|srcset|action|poster|formaction|cite|data-[a-z0-9_-]*href)\s*=/iu.test(String(source || ''));
}

function shouldScanExecutableRouteCode(path) {
  const clean = String(path || '').toLowerCase();
  return !clean || /\.(?:js|mjs)$/iu.test(clean);
}

function stringLiteralHasExternalRouteContext(source, literalMatch, externalAliases = new Set()) {
  const text = String(source || '');
  const content = String(literalMatch[2] || '');
  if (literalMatch[1] === '`' && templateRouteContentHasExternalPrefix(text, content, externalAliases)) return true;
  const queryIndex = Math.max(content.lastIndexOf('?'), content.lastIndexOf('&'));
  const prefix = queryIndex >= 0 ? routeCandidatePrefix(content, queryIndex) : '';
  if (isExternalUrlPrefix(prefix)) return true;
  const before = text.slice(0, literalMatch.index);
  const literalPrefix = before.match(/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\+\s*$/u);
  if (literalPrefix && isExternalUrlPrefix(literalPrefix[2])) return true;
  const aliasPrefix = before.match(/\b([A-Za-z_$][\w$]*)\s*\+\s*$/u);
  return Boolean(aliasPrefix && externalAliases.has(aliasPrefix[1]));
}

function escapeRe(value) {
  return stringValue(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expressionReferencePattern(expression) {
  const text = stringValue(expression).trim();
  const parts = text.split(/\s*\.\s*/u).filter(Boolean);
  if (parts.length && parts.every((part, index) => (
    part === 'this' ? index === 0 : new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(part)
  ))) {
    const [root, ...properties] = parts;
    return `\\b${escapeRe(root)}${properties.map((property) => propertyAccessorPattern(property)).join('')}`;
  }
  return `\\b${escapeRe(text)}`;
}

function expressionReferencePatternForSource(expression, source = '') {
  const text = stringValue(expression).trim();
  const parts = text.split(/\s*\.\s*/u).filter(Boolean);
  if (parts.length && parts.every((part, index) => (
    part === 'this' ? index === 0 : new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(part)
  ))) {
    const [root, ...properties] = parts;
    return `\\b${escapeRe(root)}${properties.map((property) => (
      propertyAccessorPattern(property, collectStaticStringAliases(source, property))
    )).join('')}`;
  }
  return expressionReferencePattern(expression);
}

function functionInvocationStartPattern(calleePattern) {
  return `(?:${calleePattern}\\s*(?:\\?\\.\\s*)?\\(|${calleePattern}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(?:call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](?:call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](?:call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\()`;
}

function expressionHasRouteKeyLiteral(expression) {
  STRING_LITERAL_PATTERN.lastIndex = 0;
  const text = String(expression || '');
  let match = STRING_LITERAL_PATTERN.exec(text);
  while (match) {
    if (/^(?:tab|id)$/u.test(decodeJsStringLiteralContent(match[2]))) return true;
    match = STRING_LITERAL_PATTERN.exec(text);
  }
  return false;
}

function addRouteKeyObjectAliases(aliases, name, initializer) {
  const text = stripWrappingParentheses(initializer);
  if (!text.startsWith('{')) return;
  const body = text.endsWith('}') ? text.slice(1, -1) : text.slice(1);
  splitTopLevelArgs(body).forEach((part) => {
    const field = String(part || '').trim().match(/^(?:([A-Za-z_$][\w$]*)|(['"`])([^'"`]+)\2)\s*:\s*([\s\S]+)$/u);
    if (!field) return;
    const key = field[1] || field[3] || '';
    if (!/^[A-Za-z_$][\w$]*$/u.test(key)) return;
    if (expressionHasRouteKeyLiteral(field[4]) || aliases.has(stripWrappingParentheses(field[4]))) {
      aliases.add(`${name}.${key}`);
    }
  });
}

function addExternalUrlObjectAliases(aliases, name, initializer) {
  const text = stripWrappingParentheses(initializer);
  if (!text.startsWith('{')) return;
  const body = text.endsWith('}') ? text.slice(1, -1) : text.slice(1);
  splitTopLevelArgs(body).forEach((part) => {
    const field = String(part || '').trim().match(/^(?:([A-Za-z_$][\w$]*)|(['"`])([^'"`]+)\2)\s*:\s*([\s\S]+)$/u);
    if (!field) return;
    const key = field[1] || field[3] || '';
    if (!/^[A-Za-z_$][\w$]*$/u.test(key)) return;
    if (expressionIsExternalUrl(field[4], aliases)) aliases.add(`${name}.${key}`);
  });
}

function bindingIsReassigned(source, name, fromIndex = 0) {
  const text = String(source || '');
  const re = new RegExp(`(?:^|[^\\w$.])${escapeRe(name)}\\s*(?:[+\\-*/%&|^]?=)(?!=|>)`, 'gu');
  re.lastIndex = Math.max(0, fromIndex);
  return re.test(text);
}

function collectRouteKeyAliases(source) {
  const text = String(source || '');
  const aliases = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(tab|id)\2\s*;?/gu;
  let match = re.exec(text);
  while (match) {
    aliases.add(match[1]);
    match = re.exec(text);
  }
  const declarationRe = /\b(?:const|let|var)\s+([^;]+)/gu;
  match = declarationRe.exec(text);
  while (match) {
    splitTopLevelArgs(match[1]).forEach((part) => {
      const declarator = String(part || '').trim().match(/^([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/u);
      if (!declarator) return;
      const name = declarator[1];
      const initializer = declarator[2];
      if (expressionHasRouteKeyLiteral(initializer)) aliases.add(name);
      addRouteKeyObjectAliases(aliases, name, initializer);
    });
    match = declarationRe.exec(text);
  }
  const defaultRe = /\bexport\s+default\s*(?:\(\s*)*((['"`])(?:\\[\s\S]|(?!\2)[\s\S])*?\2)(?:\s*\))*\s*;?/gu;
  match = defaultRe.exec(text);
  while (match) {
    if (expressionHasRouteKeyLiteral(match[1])) aliases.add('default');
    match = defaultRe.exec(text);
  }
  const defaultIdentifierRe = /\bexport\s+default\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*;?/gu;
  match = defaultIdentifierRe.exec(text);
  while (match) {
    if (aliases.has(match[1])) aliases.add('default');
    match = defaultIdentifierRe.exec(text);
  }
  const localDefaultExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
  match = localDefaultExportRe.exec(text);
  while (match) {
    const after = text.slice(localDefaultExportRe.lastIndex);
    if (/^\s*from\b/u.test(after)) {
      match = localDefaultExportRe.exec(text);
      continue;
    }
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      const alias = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
      if (alias && alias[2] === 'default' && aliases.has(alias[1])) aliases.add('default');
    });
    match = localDefaultExportRe.exec(text);
  }
  return aliases;
}

function collectExternalUrlAliases(source) {
  const text = String(source || '');
  const aliases = new Set();
  const re = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:\\[\s\S]|(?!\3)[\s\S])*?)\3\s*;?/gu;
  let match = re.exec(text);
  while (match) {
    if (isExternalUrlPrefix(match[4]) && (match[1] === 'const' || !bindingIsReassigned(text, match[2], re.lastIndex))) {
      aliases.add(match[2]);
    }
    match = re.exec(text);
  }
  const staticRelativeAliases = collectStaticRelativeUrlAliases(text);
  const declarationRe = /\b(?:const|let|var)\s+([^;]+)/gu;
  match = declarationRe.exec(text);
  while (match) {
    splitTopLevelArgs(match[1]).forEach((part) => {
      const declarator = String(part || '').trim().match(/^([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/u);
      if (declarator) addExternalUrlObjectAliases(aliases, declarator[1], declarator[2]);
    });
    match = declarationRe.exec(text);
  }
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const urlRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  match = urlRe.exec(text);
  while (match) {
    const parsed = extractCallArgs(text, urlRe.lastIndex);
    if (urlConstructorArgsAreExternal(parsed.args, aliases, staticRelativeAliases)
      && (match[1] === 'const' || !bindingIsReassigned(text, match[2], parsed.end))) {
      aliases.add(match[2]);
    }
    if (parsed.end > urlRe.lastIndex) urlRe.lastIndex = parsed.end;
    match = urlRe.exec(text);
  }
  const defaultRe = /\bexport\s+default\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*;?/gu;
  match = defaultRe.exec(text);
  while (match) {
    if (isExternalUrlPrefix(match[2])) aliases.add('default');
    match = defaultRe.exec(text);
  }
  const defaultIdentifierRe = /\bexport\s+default\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*;?/gu;
  match = defaultIdentifierRe.exec(text);
  while (match) {
    if (aliases.has(match[1])) aliases.add('default');
    match = defaultIdentifierRe.exec(text);
  }
  const localDefaultExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
  match = localDefaultExportRe.exec(text);
  while (match) {
    const after = text.slice(localDefaultExportRe.lastIndex);
    if (/^\s*from\b/u.test(after)) {
      match = localDefaultExportRe.exec(text);
      continue;
    }
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      const alias = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
      if (alias && alias[2] === 'default' && aliases.has(alias[1])) aliases.add('default');
    });
    match = localDefaultExportRe.exec(text);
  }
  return aliases;
}

function collectStaticRelativeUrlAliases(source) {
  const text = String(source || '');
  const aliases = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:\\[\s\S]|(?!\2)[\s\S])*?)\2\s*;?/gu;
  let match = re.exec(text);
  while (match) {
    if (!isExternalUrlPrefix(match[3])) aliases.add(match[1]);
    match = re.exec(text);
  }
  const defaultRe = /\bexport\s+default\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*;?/gu;
  match = defaultRe.exec(text);
  while (match) {
    if (!isExternalUrlPrefix(match[2])) aliases.add('default');
    match = defaultRe.exec(text);
  }
  const defaultIdentifierRe = /\bexport\s+default\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*;?/gu;
  match = defaultIdentifierRe.exec(text);
  while (match) {
    if (aliases.has(match[1])) aliases.add('default');
    match = defaultIdentifierRe.exec(text);
  }
  const localDefaultExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
  match = localDefaultExportRe.exec(text);
  while (match) {
    const after = text.slice(localDefaultExportRe.lastIndex);
    if (/^\s*from\b/u.test(after)) {
      match = localDefaultExportRe.exec(text);
      continue;
    }
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      const alias = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
      if (alias && alias[2] === 'default' && aliases.has(alias[1])) aliases.add('default');
    });
    match = localDefaultExportRe.exec(text);
  }
  return aliases;
}

function collectNamedImports(source) {
  const text = String(source || '');
  const imports = [];
  const namespaceRe = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/gu;
  let namespaceMatch = namespaceRe.exec(text);
  while (namespaceMatch) {
    imports.push({ importedName: '*', localName: namespaceMatch[1], specifier: namespaceMatch[3] });
    namespaceMatch = namespaceRe.exec(text);
  }
  const defaultRe = /\bimport\s+([A-Za-z_$][\w$]*)(?:\s*,\s*\{[\s\S]*?\})?\s*from\s*(['"])([^'"]+)\2/gu;
  let defaultMatch = defaultRe.exec(text);
  while (defaultMatch) {
    imports.push({ importedName: 'default', localName: defaultMatch[1], specifier: defaultMatch[3] });
    defaultMatch = defaultRe.exec(text);
  }
  const mixedNamedRe = /\bimport\s+[A-Za-z_$][\w$]*\s*,\s*\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2/gu;
  let mixedMatch = mixedNamedRe.exec(text);
  while (mixedMatch) {
    (mixedMatch[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      if (!spec) return;
      const alias = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u);
      if (alias) {
        imports.push({ importedName: alias[1], localName: alias[2], specifier: mixedMatch[3] });
      } else if (/^[A-Za-z_$][\w$]*$/u.test(spec)) {
        imports.push({ importedName: spec, localName: spec, specifier: mixedMatch[3] });
      }
    });
    mixedMatch = mixedNamedRe.exec(text);
  }
  const re = /\bimport\s*\{([\s\S]*?)\}\s*from\s*(['"])[^'"]+\2/gu;
  let match = re.exec(text);
  while (match) {
    const specifier = (match[0].match(/\bfrom\s*(['"])([^'"]+)\1/u) || [])[2] || '';
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      if (!spec) return;
      const alias = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u);
      if (alias) {
        imports.push({ importedName: alias[1], localName: alias[2], specifier });
      } else if (/^[A-Za-z_$][\w$]*$/u.test(spec)) {
        imports.push({ importedName: spec, localName: spec, specifier });
      }
    });
    match = re.exec(text);
  }
  return imports;
}

function collectLocalBindingNames(source) {
  const text = String(source || '');
  const bindings = new Set();
  addLocalDeclarationBindings(bindings, text, { topLevelOnly: true });
  const functionRe = /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/gu;
  let match = functionRe.exec(text);
  while (match) {
    const body = extractBlockText(text, functionRe.lastIndex - 1);
    if (routeGuardBodyLooksRelevant(body)) {
      addBindingNamesFromPattern(bindings, match[1]);
      addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    }
    match = functionRe.exec(text);
  }
  const arrowRe = /(?:^|[^\w$])(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gu;
  match = arrowRe.exec(text);
  while (match) {
    const body = extractBlockText(text, arrowRe.lastIndex - 1);
    if (routeGuardBodyLooksRelevant(body)) {
      addBindingNamesFromPattern(bindings, match[1]);
      addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    }
    match = arrowRe.exec(text);
  }
  const expressionArrowRe = /(?:^|[^\w$])(?:async\s*)?\(([^)]*)\)\s*=>\s*(?!\s*\{)/gu;
  match = expressionArrowRe.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, expressionArrowRe.lastIndex);
    if (routeGuardBodyLooksRelevant(expression)) addBindingNamesFromPattern(bindings, match[1]);
    expressionArrowRe.lastIndex += expression.length;
    match = expressionArrowRe.exec(text);
  }
  const singleArrowRe = /(?:^|[^\w$])(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*\{/gu;
  match = singleArrowRe.exec(text);
  while (match) {
    const body = extractBlockText(text, singleArrowRe.lastIndex - 1);
    if (routeGuardBodyLooksRelevant(body)) {
      bindings.add(match[1]);
      addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    }
    match = singleArrowRe.exec(text);
  }
  const singleExpressionArrowRe = /(?:^|[^\w$])(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*(?!\s*\{)/gu;
  match = singleExpressionArrowRe.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, singleExpressionArrowRe.lastIndex);
    if (routeGuardBodyLooksRelevant(expression)) bindings.add(match[1]);
    singleExpressionArrowRe.lastIndex += expression.length;
    match = singleExpressionArrowRe.exec(text);
  }
  const methodRe = /(?:^|[,{]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*\(([^)]*)\)\s*\{/gu;
  match = methodRe.exec(text);
  while (match) {
    const body = extractBlockText(text, methodRe.lastIndex - 1);
    if (routeGuardBodyLooksRelevant(body)) {
      addBindingNamesFromPattern(bindings, match[1]);
      addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    }
    match = methodRe.exec(text);
  }
  return bindings;
}

function addLocalDeclarationBindings(bindings, source, options = {}) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const declarationRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  let match = declarationRe.exec(scan);
  while (match) {
    if (!options.topLevelOnly || braceDepthAt(text, match.index) === 0) bindings.add(match[1]);
    match = declarationRe.exec(scan);
  }
  const destructuredRe = /\b(?:const|let|var)\s*\{([\s\S]*?)\}/gu;
  match = destructuredRe.exec(scan);
  while (match) {
    if (!options.topLevelOnly || braceDepthAt(text, match.index) === 0) addBindingNamesFromPattern(bindings, match[1]);
    match = destructuredRe.exec(scan);
  }
  const arrayDestructuredRe = /\b(?:const|let|var)\s*\[([\s\S]*?)\]/gu;
  match = arrayDestructuredRe.exec(scan);
  while (match) {
    if (!options.topLevelOnly || braceDepthAt(text, match.index) === 0) addBindingNamesFromPattern(bindings, match[1]);
    match = arrayDestructuredRe.exec(scan);
  }
}

function stackStartsWith(stack, prefix) {
  if (prefix.length > stack.length) return false;
  return prefix.every((value, index) => stack[index] === value);
}

function collectNestedFunctionBodyRanges(source) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const ranges = [];
  const addRange = (openBraceIndex) => {
    if (openBraceIndex < 0) return;
    const span = extractBlockSpan(text, openBraceIndex);
    ranges.push({ start: openBraceIndex, end: span.end });
  };
  const functionRe = /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/gu;
  let match = functionRe.exec(scan);
  while (match) {
    addRange(functionRe.lastIndex - 1);
    match = functionRe.exec(scan);
  }
  const arrowBlockRe = /=>\s*\{/gu;
  match = arrowBlockRe.exec(scan);
  while (match) {
    addRange(arrowBlockRe.lastIndex - 1);
    match = arrowBlockRe.exec(scan);
  }
  const controlNames = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
  const methodRe = new RegExp(`(?:^|[,\\{]\\s*)(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*\\([^)]*\\)\\s*\\{`, 'gu');
  match = methodRe.exec(scan);
  while (match) {
    if (!controlNames.has(match[1])) addRange(methodRe.lastIndex - 1);
    match = methodRe.exec(scan);
  }
  return ranges;
}

function indexIsInsideRange(index, ranges) {
  return ranges.some((range) => index > range.start && index < range.end);
}

function addVisibleLocalDeclarationBindings(bindings, source, index) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const visibleStack = blockStackAt(text, index);
  const nestedFunctionRanges = collectNestedFunctionBodyRanges(text);
  const declarationRe = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  let match = declarationRe.exec(scan);
  while (match) {
    const declarationStack = blockStackAt(text, match.index);
    if ((match[1] === 'var' && !indexIsInsideRange(match.index, nestedFunctionRanges))
      || stackStartsWith(visibleStack, declarationStack)) {
      bindings.add(match[2]);
    }
    match = declarationRe.exec(scan);
  }
  const destructuredRe = /\b(const|let|var)\s*\{([\s\S]*?)\}/gu;
  match = destructuredRe.exec(scan);
  while (match) {
    const declarationStack = blockStackAt(text, match.index);
    if ((match[1] === 'var' && !indexIsInsideRange(match.index, nestedFunctionRanges))
      || stackStartsWith(visibleStack, declarationStack)) {
      addBindingNamesFromPattern(bindings, match[2]);
    }
    match = destructuredRe.exec(scan);
  }
  const arrayDestructuredRe = /\b(const|let|var)\s*\[([\s\S]*?)\]/gu;
  match = arrayDestructuredRe.exec(scan);
  while (match) {
    const declarationStack = blockStackAt(text, match.index);
    if ((match[1] === 'var' && !indexIsInsideRange(match.index, nestedFunctionRanges))
      || stackStartsWith(visibleStack, declarationStack)) {
      addBindingNamesFromPattern(bindings, match[2]);
    }
    match = arrayDestructuredRe.exec(scan);
  }
}

function addBindingNamesFromPattern(bindings, pattern) {
  const text = String(pattern || '');
  text.split(',').forEach((part) => {
    const clean = part.trim().replace(/^[{\[]\s*|\s*[}\]]$/gu, '');
    const simple = clean.match(/^([A-Za-z_$][\w$]*)$/u);
    if (simple) {
      bindings.add(simple[1]);
      return;
    }
    const defaulted = clean.match(/^([A-Za-z_$][\w$]*)\s*=/u);
    if (defaulted) {
      bindings.add(defaulted[1]);
      return;
    }
    const alias = clean.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)(?:\s*=.*)?$/u);
    if (alias) bindings.add(alias[1]);
  });
  const shorthandRe = /(?:^|[,\{\[]\s*)([A-Za-z_$][\w$]*)(?:\s*=\s*[^,\}\]]+)?\s*(?=[,\}\]])/gu;
  let match = shorthandRe.exec(text);
  while (match) {
    bindings.add(match[1]);
    match = shorthandRe.exec(text);
  }
}

function routeGuardBodyLooksRelevant(body) {
  return /\b(?:new\s+URL|URLSearchParams|searchParams|location)\b|[?&][^=&#\s]+\s*=/u.test(String(body || ''));
}

function braceDepthAt(source, index) {
  const text = String(source || '').slice(0, Math.max(0, index));
  let depth = 0;
  let quote = '';
  let escaped = false;
  let regex = false;
  let inClass = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') inClass = true;
      else if (ch === ']' && inClass) inClass = false;
      else if (ch === '/' && !inClass) regex = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 1;
      while (i + 1 < text.length) {
        if (text[i + 1] === '*' && text[i + 2] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      regex = true;
      inClass = false;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
  }
  return depth;
}

function blockStackAt(source, index) {
  const text = String(source || '');
  const stack = [];
  let quote = '';
  let escaped = false;
  let regex = false;
  let inClass = false;
  for (let i = 0; i < Math.min(text.length, Math.max(0, index)); i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') inClass = true;
      else if (ch === ']' && inClass) inClass = false;
      else if (ch === '/' && !inClass) regex = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 1;
      while (i + 1 < text.length) {
        if (text[i + 1] === '*' && text[i + 2] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      regex = true;
      inClass = false;
      continue;
    }
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length) stack.pop();
  }
  return stack;
}

function referenceIsShadowedInScope(source, name, scope, scopedIndex) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const normalizedScope = scope || { start: 0, end: text.length };
  const globalIndex = normalizedScope.start + scopedIndex;
  const rootName = String(name || '').split(/\s*\.\s*/u).filter(Boolean)[0] || '';
  if (!rootName) return false;
  const before = scan.slice(normalizedScope.start, globalIndex);
  const scopeStack = blockStackAt(text, normalizedScope.start);
  const referenceStack = blockStackAt(text, globalIndex);
  const stackIsReferenceAncestor = (stack) => (
    stack.length > scopeStack.length
    && stack.length <= referenceStack.length
    && stack.every((open, index) => referenceStack[index] === open)
  );
  const shadowRe = new RegExp(`\\b(?:const|let|var|function)\\s+${escapeRe(rootName)}\\b`, 'gu');
  let shadow = shadowRe.exec(before);
  while (shadow) {
    if (stackIsReferenceAncestor(blockStackAt(text, normalizedScope.start + shadow.index))) return true;
    shadow = shadowRe.exec(before);
  }
  return false;
}

function extractBlockText(source, openBraceIndex) {
  return extractBlockSpan(source, openBraceIndex).body;
}

function topLevelRouteGuardSource(source) {
  const text = String(source || '');
  let out = '';
  let quote = '';
  let escaped = false;
  let regex = false;
  let inClass = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (regex) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') inClass = true;
      else if (ch === ']' && inClass) inClass = false;
      else if (ch === '/' && !inClass) regex = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      while (i + 1 < text.length) {
        if (text[i + 1] === '*' && text[i + 2] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        const blockCh = text[i + 1];
        out += blockCh === '\n' || blockCh === '\r' ? blockCh : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      regex = true;
      inClass = false;
      out += ch;
      continue;
    }
    if (ch === '{') {
      const span = extractBlockSpan(text, i);
      out += ' '.repeat(Math.max(1, span.end - i));
      i = span.end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function extractBlockSpan(source, openBraceIndex) {
  const text = String(source || '');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let regex = false;
  let inClass = false;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') inClass = true;
      else if (ch === ']' && inClass) inClass = false;
      else if (ch === '/' && !inClass) regex = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 1;
      while (i + 1 < text.length) {
        if (text[i + 1] === '*' && text[i + 2] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && routeGuardPreviousTokenAllowsRegex(text, i)) {
      regex = true;
      inClass = false;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openBraceIndex + 1, i), end: i + 1 };
    }
  }
  return { body: text.slice(openBraceIndex + 1), end: text.length };
}

function normalizeRouteGuardContext(contextSource, fallbackSource = '', fallbackPath = '') {
  if (contextSource && typeof contextSource === 'object' && Array.isArray(contextSource.files)) {
    const files = contextSource.files.map((file) => ({
      path: String((file && file.path) || '').replace(/\\+/g, '/'),
      source: stripCommentsForRouteGuard((file && file.source) || '')
    }));
    return {
      path: String(contextSource.path || fallbackPath || '').replace(/\\+/g, '/'),
      files,
      source: files.map((file) => file.source).join('\n')
    };
  }
  return {
    path: String(fallbackPath || '').replace(/\\+/g, '/'),
    files: [],
    source: String(contextSource || fallbackSource || '')
  };
}

function resolveImportPath(fromPath, specifier) {
  const spec = String(specifier || '').trim();
  if (!spec.startsWith('.')) return '';
  const fromDir = String(fromPath || '').split('/').slice(0, -1).join('/');
  const normalized = `${fromDir ? `${fromDir}/` : ''}${spec}`.split('/');
  const out = [];
  normalized.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') out.pop();
    else out.push(part);
  });
  const joined = out.join('/');
  return /\.[a-z0-9]+$/iu.test(joined) ? joined : `${joined}.js`;
}

function collectContextFileAliases(file, collector, context, seen = new Set(), cache = new Map()) {
  const key = `${file.path}:${collector.name || 'collector'}`;
  if (cache.has(key)) return new Set(cache.get(key));
  if (seen.has(key)) return new Set();
  seen.add(key);
  const collectFileAliases = () => {
    if (collector === collectRouteUrlFactoryAliases) {
      const fileContext = { ...context, path: file.path };
      const externalAliases = mergeImportedContextAliases(
        collectExternalUrlAliases(file.source),
        collectExternalUrlAliases,
        file.source,
        fileContext,
        { shadow: false }
      );
      const staticRelativeAliases = mergeImportedContextAliases(
        collectStaticRelativeUrlAliases(file.source),
        collectStaticRelativeUrlAliases,
        file.source,
        fileContext,
        { shadow: false }
      );
      return collector(file.source, externalAliases, staticRelativeAliases);
    }
    return collector(file.source);
  };
  const out = new Set(collectFileAliases());
  const importedAliases = new Set();
  collectNamedImports(file.source).forEach(({ importedName, localName, specifier }) => {
    const targetPath = resolveImportPath(file.path, specifier);
    const target = targetPath ? context.files.find((entry) => entry.path === targetPath) : null;
    if (!target) return;
    const targetAliases = collectContextFileAliases(target, collector, context, seen, cache);
    if (targetAliases.has(importedName)) importedAliases.add(localName);
  });
  const exportableAliases = new Set([...out, ...importedAliases]);
  const reExportRe = /\bexport\s*\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2/gu;
  let match = reExportRe.exec(file.source);
  while (match) {
    const targetPath = resolveImportPath(file.path, match[3]);
    const target = targetPath ? context.files.find((entry) => entry.path === targetPath) : null;
    if (!target) {
      match = reExportRe.exec(file.source);
      continue;
    }
    const targetAliases = collectContextFileAliases(target, collector, context, seen, cache);
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      if (!spec) return;
      const alias = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u);
      const importedName = alias ? alias[1] : spec;
      const exportedName = alias ? alias[2] : spec;
      if (/^[A-Za-z_$][\w$]*$/u.test(importedName) && targetAliases.has(importedName)) out.add(exportedName);
    });
    match = reExportRe.exec(file.source);
  }
  const localExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
  match = localExportRe.exec(file.source);
  while (match) {
    const after = file.source.slice(localExportRe.lastIndex);
    if (!/^\s*from\b/u.test(after)) {
      (match[1] || '').split(',').forEach((part) => {
        const spec = part.trim();
        if (!spec) return;
        const alias = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u);
        const localName = alias ? alias[1] : spec;
        const exportedName = alias ? alias[2] : spec;
        if (/^[A-Za-z_$][\w$]*$/u.test(localName) && exportableAliases.has(localName)) out.add(exportedName);
      });
    }
    match = localExportRe.exec(file.source);
  }
  const starRe = /\bexport\s+\*\s+from\s*(['"])([^'"]+)\1/gu;
  match = starRe.exec(file.source);
  while (match) {
    const targetPath = resolveImportPath(file.path, match[2]);
    const target = targetPath ? context.files.find((entry) => entry.path === targetPath) : null;
    if (target) {
      const targetAliases = collectContextFileAliases(target, collector, context, seen, cache);
      targetAliases.forEach((alias) => out.add(alias));
    }
    match = starRe.exec(file.source);
  }
  seen.delete(key);
  cache.set(key, out);
  return out;
}

function mergeImportedContextAliases(localAliases, collector, source, context, options = {}) {
  const out = new Set(localAliases || []);
  const imports = collectNamedImports(source);
  const shadowed = options.shadow === false ? new Set() : collectLocalBindingNames(source);
  imports.forEach(({ importedName, localName, specifier }) => {
    const targetPath = resolveImportPath(context.path, specifier);
    const target = targetPath ? context.files.find((file) => file.path === targetPath) : null;
    if (!target) return;
    const contextAliases = collectContextFileAliases(target, collector, context);
    if (importedName === '*') {
      if (!shadowed.has(localName)) {
        contextAliases.forEach((alias) => out.add(`${localName}.${alias}`));
      }
      return;
    }
    if (contextAliases.has(importedName) && !shadowed.has(localName)) out.add(localName);
  });
  return out;
}

function routeKeyAliasParamIsShadowedAt(source, name, index) {
  const text = String(source || '');
  const rootName = String(name || '').split(/\s*\.\s*/u).filter(Boolean)[0] || '';
  if (!rootName) return false;
  const paramsShadow = (paramsText) => {
    const bindings = new Set();
    addBindingNamesFromPattern(bindings, paramsText);
    return bindings.has(rootName);
  };
  const bodyContainsIndex = (openBraceIndex) => {
    const span = extractBlockSpan(text, openBraceIndex);
    return index > openBraceIndex && index < span.end;
  };
  const functionRe = /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/gu;
  let match = functionRe.exec(text);
  while (match) {
    if (match.index <= index && bodyContainsIndex(functionRe.lastIndex - 1) && paramsShadow(match[1])) return true;
    match = functionRe.exec(text);
  }
  const methodRe = new RegExp(`(?:^|[,\\{])\\s*(?:async\\s+)?${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE}\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = methodRe.exec(text);
  while (match) {
    if (match.index <= index && bodyContainsIndex(methodRe.lastIndex - 1) && paramsShadow(match[1])) return true;
    match = methodRe.exec(text);
  }
  const arrowBlockRe = /(?:^|[^\w$])(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gu;
  match = arrowBlockRe.exec(text);
  while (match) {
    if (match.index <= index && bodyContainsIndex(arrowBlockRe.lastIndex - 1) && paramsShadow(match[1])) return true;
    match = arrowBlockRe.exec(text);
  }
  const singleArrowBlockRe = new RegExp(`(?:^|[^\\w$])(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*=>\\s*\\{`, 'gu');
  match = singleArrowBlockRe.exec(text);
  while (match) {
    if (match.index <= index && bodyContainsIndex(singleArrowBlockRe.lastIndex - 1) && paramsShadow(match[1])) return true;
    match = singleArrowBlockRe.exec(text);
  }
  return false;
}

function routeKeyAliasIsShadowedAt(value, aliases, source, index) {
  const expression = stripWrappingParentheses(value);
  const importedAliases = aliases && aliases.importedAliases instanceof Set ? aliases.importedAliases : new Set();
  const localAliases = aliases && aliases.localAliases instanceof Set ? aliases.localAliases : new Set();
  if (!importedAliases.has(expression) || localAliases.has(expression)) return false;
  const text = String(source || '');
  return referenceIsShadowedInScope(text, expression, { start: 0, end: text.length }, index)
    || routeKeyAliasParamIsShadowedAt(text, expression, index);
}

function sourceArgIsRouteKey(arg, aliases, source = '', index = 0) {
  const value = String(arg || '').trim();
  const staticValue = staticStringExpressionValue(value);
  if (/^(?:tab|id)$/u.test(staticValue || '')) return true;
  const matchesAlias = new RegExp(`^(?:${routeKeyExpressionPattern(aliases)})$`, 'u').test(value);
  return matchesAlias && !routeKeyAliasIsShadowedAt(value, aliases, source, index);
}

const STATIC_STRING_CONCAT_PATTERN_CACHE = new Map();

function quotedStaticPropertyPartPattern(value) {
  const escaped = escapeRe(value);
  return `(?:"${escaped}"|'${escaped}'|\`${escaped}\`)`;
}

function staticStringConcatExpressionPattern(value) {
  const text = String(value || '');
  if (!text) return '';
  if (STATIC_STRING_CONCAT_PATTERN_CACHE.has(text)) return STATIC_STRING_CONCAT_PATTERN_CACHE.get(text);
  const expressions = new Set([quotedStaticPropertyPartPattern(text)]);
  for (let first = 1; first < text.length; first += 1) {
    expressions.add([
      text.slice(0, first),
      text.slice(first)
    ].map(quotedStaticPropertyPartPattern).join('\\s*\\+\\s*'));
    for (let second = first + 1; second < text.length; second += 1) {
      expressions.add([
        text.slice(0, first),
        text.slice(first, second),
        text.slice(second)
      ].map(quotedStaticPropertyPartPattern).join('\\s*\\+\\s*'));
    }
  }
  const pattern = `(?:${Array.from(expressions).join('|')})`;
  STATIC_STRING_CONCAT_PATTERN_CACHE.set(text, pattern);
  return pattern;
}

function propertyAccessorPattern(name, aliases = new Set()) {
  const escaped = escapeRe(name);
  const aliasPattern = Array.from(aliases || []).map(escapeRe).join('|');
  const staticExpressionPattern = staticStringConcatExpressionPattern(name);
  const aliasAccess = aliasPattern
    ? `|\\s*(?:\\?\\.\\s*)?\\[\\s*(?:${aliasPattern})\\s*\\]`
    : '';
  return `(?:\\s*\\?\\.\\s*${escaped}|\\s*\\.\\s*${escaped}|\\s*\\?\\.\\s*\\[\\s*(?:${staticExpressionPattern})\\s*\\]|\\s*\\[\\s*(?:${staticExpressionPattern})\\s*\\]${aliasAccess})`;
}

function routeKeyWritePattern(owner, property = '', propertyAliases = new Set(), mutatorAliases = {}) {
  const ownerPattern = expressionReferencePattern(owner);
  const suffix = property ? propertyAccessorPattern(property, propertyAliases) : '';
  const mutator = `(?:${propertyAccessorPattern('set', mutatorAliases.set)}|${propertyAccessorPattern('append', mutatorAliases.append)}|${propertyAccessorPattern('delete', mutatorAliases.delete)})`;
  const parenthesizedRouteKey = `(?:\\(\\s*)*(?:${IDENTIFIER_PATTERN.source}|${ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE})(?:\\s*\\))*`;
  return new RegExp(`${ownerPattern}${suffix}${mutator}\\s*(?:\\?\\.\\s*)?\\(\\s*(${parenthesizedRouteKey}|[^,\\)]+)\\s*(?:,|\\))`, 'gu');
}

function routeKeyDispatchPattern(owner, property = '', propertyAliases = new Set(), mutatorAliases = {}) {
  const ownerPattern = expressionReferencePattern(owner);
  const suffix = property ? propertyAccessorPattern(property, propertyAliases) : '';
  const target = `${ownerPattern}${suffix}`;
  const mutator = `(?:${propertyAccessorPattern('set', mutatorAliases.set)}|${propertyAccessorPattern('append', mutatorAliases.append)}|${propertyAccessorPattern('delete', mutatorAliases.delete)})`;
  return new RegExp(`${target}${mutator}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`, 'gu');
}

function collectBoundRouteMutators(source, owner, property = '', propertyAliases = new Set(), mutatorAliases = {}) {
  const text = String(source || '');
  const out = new Set();
  const ownerPattern = expressionReferencePattern(owner);
  const suffix = property ? propertyAccessorPattern(property, propertyAliases) : '';
  const target = `${ownerPattern}${suffix}`;
  const mutator = `(?:${propertyAccessorPattern('set', mutatorAliases.set)}|${propertyAccessorPattern('append', mutatorAliases.append)}|${propertyAccessorPattern('delete', mutatorAliases.delete)})`;
  const re = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*${target}${mutator}\\s*\\.\\s*bind\\s*\\(\\s*${target}\\s*\\)`, 'gu');
  let match = re.exec(text);
  while (match) {
    out.add(match[1]);
    match = re.exec(text);
  }
  const unboundRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*${target}${mutator}\\s*;?`, 'gu');
  match = unboundRe.exec(text);
  while (match) {
    if (match[1] === 'const' || !bindingIsReassigned(text, match[2], unboundRe.lastIndex)) out.add(match[2]);
    match = unboundRe.exec(text);
  }
  const destructureRe = new RegExp(`\\b(const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${target}\\b`, 'gu');
  match = destructureRe.exec(text);
  while (match) {
    const kind = match[1];
    const body = match[2] || '';
    ['set', 'append', 'delete'].forEach((key) => {
      for (const alias of collectDestructuredStaticPropertyAliases(body, key)) {
        if (kind === 'const' || !bindingIsReassigned(text, alias, destructureRe.lastIndex)) out.add(alias);
      }
    });
    match = destructureRe.exec(text);
  }
  return out;
}

function containsRouteKeyWriteForOwner(source, owner, aliases, property = '') {
  const text = String(source || '');
  const propertyAliases = property ? collectStaticStringAliases(text, property) : new Set();
  const mutatorAliases = {
    set: collectStaticStringAliases(text, 'set'),
    append: collectStaticStringAliases(text, 'append'),
    delete: collectStaticStringAliases(text, 'delete')
  };
  const re = routeKeyWritePattern(owner, property, propertyAliases, mutatorAliases);
  let match = re.exec(text);
  while (match) {
    if (sourceArgIsRouteKey(match[1], aliases, text, match.index)) return true;
    match = re.exec(text);
  }
  const dispatchRe = routeKeyDispatchPattern(owner, property, propertyAliases, mutatorAliases);
  match = dispatchRe.exec(text);
  while (match) {
    const method = match[1] || match[2] || match[3];
    const parsed = extractCallArgs(text, dispatchRe.lastIndex);
    const parts = splitTopLevelArgs(parsed.args);
    const applyArgs = method === 'apply' ? splitTopLevelArgs((parts[1] || '').trim().replace(/^\[\s*|\s*\]$/gu, '')) : [];
    const routeKeyArg = method === 'apply' ? applyArgs[0] : parts[1];
    if (sourceArgIsRouteKey(routeKeyArg || '', aliases, text, match.index)) return true;
    if (parsed.end > dispatchRe.lastIndex) dispatchRe.lastIndex = parsed.end;
    match = dispatchRe.exec(text);
  }
  const parenthesizedRouteKey = `(?:\\(\\s*)*(?:${IDENTIFIER_PATTERN.source}|${ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE})(?:\\s*\\))*`;
  const ownerPattern = expressionReferencePattern(owner);
  const suffix = property ? propertyAccessorPattern(property, propertyAliases) : '';
  const target = `${ownerPattern}${suffix}`;
  for (const mutator of collectBoundRouteMutators(text, owner, property, propertyAliases, mutatorAliases)) {
    const mutatorRe = new RegExp(`(?:^|[^\\w$.])${escapeRe(mutator)}\\s*(?:\\?\\.\\s*)?\\(\\s*(${parenthesizedRouteKey}|[^,\\)]+)\\s*(?:,|\\))`, 'gu');
    match = mutatorRe.exec(text);
    while (match) {
      if (!hasMemberAccessPrefix(text, match.index) && sourceArgIsRouteKey(match[1], aliases, text, match.index)) return true;
      match = mutatorRe.exec(text);
    }
    const mutatorDispatchRe = new RegExp(`(?:^|[^\\w$.])${escapeRe(mutator)}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`, 'gu');
    match = mutatorDispatchRe.exec(text);
    while (match) {
      const method = match[1] || match[2] || match[3];
      const parsed = extractCallArgs(text, mutatorDispatchRe.lastIndex);
      const parts = splitTopLevelArgs(parsed.args);
      const applyArgs = method === 'apply' ? splitTopLevelArgs((parts[1] || '').trim().replace(/^\[\s*|\s*\]$/gu, '')) : [];
      const routeKeyArg = method === 'apply' ? applyArgs[0] : parts[1];
      if (!hasMemberAccessPrefix(text, match.index) && sourceArgIsRouteKey(routeKeyArg || '', aliases, text, match.index)) return true;
      if (parsed.end > mutatorDispatchRe.lastIndex) mutatorDispatchRe.lastIndex = parsed.end;
      match = mutatorDispatchRe.exec(text);
    }
  }
  return false;
}

function collectUrlSearchParamsConstructors(source) {
  const text = String(source || '');
  const out = [];
  const seen = new Set();
  const constructorAliases = collectUrlSearchParamsConstructorAliases(text);
  const constructorPattern = urlSearchParamsConstructorPattern(constructorAliases);
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu'),
    new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_PATTERN_SOURCE})\\s*=\\s*(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      const parsed = extractCallArgs(text, re.lastIndex);
      const key = `${match[1]}:${parsed.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name: match[1], args: parsed.args || '' });
      }
      if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
      match = re.exec(text);
    }
  });
  return out;
}

function collectUrlSearchParamsVariables(source) {
  return new Set(collectUrlSearchParamsConstructors(source).map((item) => item.name));
}

function collectUrlSearchParamsInitializers(source) {
  return collectUrlSearchParamsConstructors(source);
}

function collectUrlSearchParamsConstructorAliases(source) {
  const text = String(source || '');
  const aliases = new Set();
  const re = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:(?:window|globalThis)\\s*\\.\\s*)?URLSearchParams\\b`, 'gu');
  let match = re.exec(text);
  while (match) {
    aliases.add(match[1]);
    match = re.exec(text);
  }
  const destructureRe = /\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:window|globalThis)\b/gu;
  let destructure = destructureRe.exec(text);
  while (destructure) {
    const body = destructure[1] || '';
    const aliasRe = /(?:^|,)\s*URLSearchParams\s*:\s*([A-Za-z_$][\w$]*)/gu;
    let alias = aliasRe.exec(body);
    while (alias) {
      aliases.add(alias[1]);
      alias = aliasRe.exec(body);
    }
    if (/(?:^|,)\s*URLSearchParams\s*(?:,|$)/u.test(body)) aliases.add('URLSearchParams');
    destructure = destructureRe.exec(text);
  }
  return aliases;
}

function urlSearchParamsConstructorPattern(aliases = new Set()) {
  const aliasPattern = aliasExpressionPattern(aliases);
  return aliasPattern
    ? `(?:(?:window|globalThis)\\s*\\.\\s*)?URLSearchParams|${aliasPattern}`
    : `(?:(?:window|globalThis)\\s*\\.\\s*)?URLSearchParams`;
}

function collectUrlConstructorAliases(source) {
  const text = String(source || '');
  const aliases = new Set();
  const re = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:(?:window|globalThis)\\s*\\.\\s*)?URL\\b`, 'gu');
  let match = re.exec(text);
  while (match) {
    aliases.add(match[1]);
    match = re.exec(text);
  }
  const destructureRe = /\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:window|globalThis)\b/gu;
  let destructure = destructureRe.exec(text);
  while (destructure) {
    const body = destructure[1] || '';
    const aliasRe = /(?:^|,)\s*URL\s*:\s*([A-Za-z_$][\w$]*)/gu;
    let alias = aliasRe.exec(body);
    while (alias) {
      aliases.add(alias[1]);
      alias = aliasRe.exec(body);
    }
    if (/(?:^|,)\s*URL\s*(?:,|$)/u.test(body)) aliases.add('URL');
    destructure = destructureRe.exec(text);
  }
  return aliases;
}

function urlConstructorPattern(aliases = new Set()) {
  const aliasPattern = aliasExpressionPattern(aliases);
  return aliasPattern
    ? `${URL_CONSTRUCTOR_PATTERN_SOURCE}|${aliasPattern}`
    : URL_CONSTRUCTOR_PATTERN_SOURCE;
}

function extractCallArgs(source, argsStart) {
  const text = String(source || '');
  let depth = 1;
  let quote = '';
  let escaped = false;
  for (let i = argsStart; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { args: text.slice(argsStart, i), end: i + 1 };
      }
    }
  }
  return { args: text.slice(argsStart), end: text.length };
}

function extractAssignmentExpression(source, valueStart) {
  const text = String(source || '');
  let start = valueStart;
  while (start < text.length && /\s/u.test(text[start])) start += 1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === '\n' || ch === '\r')) {
      if (ch === '\n' || ch === '\r') {
        let prev = i - 1;
        while (prev >= start && /\s/u.test(text[prev])) prev -= 1;
        let next = i + 1;
        while (next < text.length && /\s/u.test(text[next])) next += 1;
        if (/[+\-*/%&|?:.,]$/u.test(text[prev] || '') || /^[+\-*/%&|?:.,]/u.test(text[next] || '')) continue;
      }
      return text.slice(start, i);
    }
  }
  return text.slice(start);
}

function splitTopLevelArgs(args) {
  const text = String(args || '');
  const out = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ',') {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

function aliasAlternation(aliases) {
  return Array.from(aliases || []).map(escapeRe).join('|');
}

function aliasExpressionPattern(aliases) {
  const aliasPattern = Array.from(aliases || []).map(expressionReferencePattern).join('|');
  return aliasPattern ? `(?:${aliasPattern}|\\(\\s*(?:${aliasPattern})\\s*\\))` : '';
}

function hasMemberAccessPrefix(source, index) {
  const text = String(source || '');
  let cursor = Math.max(0, index) - 1;
  while (cursor >= 0 && /\s/u.test(text[cursor])) cursor -= 1;
  return text[cursor] === '.';
}

function objectPropertyNameFromPart(part) {
  const text = String(part || '').trim();
  const computed = text.match(new RegExp(`^\\[\\s*(${STATIC_MEMBER_STRING_PATTERN_SOURCE})\\s*\\]\\s*:`, 'u'));
  if (computed) {
    const value = staticStringExpressionValue(computed[1]);
    return new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(value || '') ? value : '';
  }
  const quoted = text.match(new RegExp(`^(${STATIC_MEMBER_STRING_PATTERN_SOURCE})\\s*:`, 'u'));
  if (quoted) {
    const value = staticStringExpressionValue(quoted[1]);
    return new RegExp(`^${IDENTIFIER_PATTERN.source}$`, 'u').test(value || '') ? value : '';
  }
  const named = text.match(new RegExp(`^(${IDENTIFIER_PATTERN.source})\\s*:`, 'u'));
  if (named) return named[1];
  const shorthand = text.match(new RegExp(`^(${IDENTIFIER_PATTERN.source})$`, 'u'));
  return shorthand ? shorthand[1] : '';
}

function objectPropertyValueFromPart(part) {
  const text = String(part || '').trim();
  const computed = text.match(new RegExp(`^\\[\\s*${STATIC_MEMBER_STRING_PATTERN_SOURCE}\\s*\\]\\s*:\\s*([\\s\\S]+)$`, 'u'));
  if (computed) return computed[1].trim();
  const quoted = text.match(new RegExp(`^${STATIC_MEMBER_STRING_PATTERN_SOURCE}\\s*:\\s*([\\s\\S]+)$`, 'u'));
  if (quoted) return quoted[1].trim();
  const named = text.match(new RegExp(`^${IDENTIFIER_PATTERN.source}\\s*:\\s*([\\s\\S]+)$`, 'u'));
  if (named) return named[1].trim();
  const shorthand = text.match(new RegExp(`^(${IDENTIFIER_PATTERN.source})$`, 'u'));
  return shorthand ? shorthand[1] : '';
}

function expressionReferencesRouteFactory(expression, factories) {
  const value = stripWrappingParentheses(expression);
  for (const factory of factories || []) {
    if (new RegExp(`^${expressionReferencePattern(factory)}$`, 'u').test(value)) return true;
  }
  return false;
}

function routeFactoryReferenceName(expression, factories, isReferenceShadowed = null, index = 0, source = '') {
  const value = stripWrappingParentheses(expression);
  for (const factory of factories || []) {
    if (new RegExp(`^${expressionReferencePatternForSource(factory, source)}$`, 'u').test(value)
      && !(isReferenceShadowed && isReferenceShadowed(factory, index))) {
      return factory;
    }
  }
  return '';
}

function routeFactoryBindReferenceName(expression, factories, isReferenceShadowed = null, index = 0, source = '') {
  const value = stripWrappingParentheses(expression);
  for (const factory of factories || []) {
    if (new RegExp(`^(?:\\(\\s*)*${expressionReferencePatternForSource(factory, source)}\\s*(?:\\))*\\s*(?:\\?\\.\\s*|\\.\\s*)bind\\s*\\(`, 'u').test(value)
      && !(isReferenceShadowed && isReferenceShadowed(factory, index))) {
      return factory;
    }
  }
  return '';
}

function expandRouteUrlFactoryAliases(source, factories, options = {}) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const out = new Set(factories || []);
  const isReferenceShadowed = typeof options.isReferenceShadowed === 'function' ? options.isReferenceShadowed : null;
  const rootFactories = new Set(factories || []);
  const referenceIsShadowed = (factory, index) => (
    rootFactories.has(factory) && isReferenceShadowed && isReferenceShadowed(factory, index)
  );
  let changed = true;
  while (changed) {
    changed = false;
    if (!out.size) break;
    const bindingAliasRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*`, 'gu');
    let alias = bindingAliasRe.exec(scan);
    while (alias) {
      const expression = extractAssignmentExpression(text, bindingAliasRe.lastIndex);
      const directFactory = routeFactoryReferenceName(expression, out, referenceIsShadowed, alias.index, text);
      const bindFactory = directFactory ? '' : routeFactoryBindReferenceName(expression, out, referenceIsShadowed, alias.index, text);
      if ((directFactory || bindFactory) && !out.has(alias[2]) && (alias[1] === 'const' || !bindingIsReassigned(text, alias[2], bindingAliasRe.lastIndex + expression.length))) {
        out.add(alias[2]);
        changed = true;
      }
      bindingAliasRe.lastIndex += expression.length;
      alias = bindingAliasRe.exec(scan);
    }
    const memberAliasRe = new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE})\\s*=\\s*(?!=|>)`, 'gu');
    alias = memberAliasRe.exec(scan);
    while (alias) {
      const expression = extractAssignmentExpression(text, memberAliasRe.lastIndex);
      const aliasName = normalizeStaticMemberExpression(alias[1]);
      if (routeFactoryReferenceName(expression, out, referenceIsShadowed, alias.index, text) && !out.has(aliasName)) {
        out.add(aliasName);
        changed = true;
      }
      memberAliasRe.lastIndex += expression.length;
      alias = memberAliasRe.exec(scan);
    }
    const objectAliasRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*\\{`, 'gu');
    let objectAlias = objectAliasRe.exec(scan);
    while (objectAlias) {
      const kind = objectAlias[1];
      const objectName = objectAlias[2];
      const objectSpan = extractBlockSpan(text, objectAliasRe.lastIndex - 1);
      if (kind === 'const' || !bindingIsReassigned(text, objectName, objectAliasRe.lastIndex)) {
        for (const part of splitTopLevelArgs(objectSpan.body)) {
          const property = objectPropertyNameFromPart(part);
          const value = objectPropertyValueFromPart(part);
          if (property && value && routeFactoryReferenceName(value, out, referenceIsShadowed, objectAlias.index, text)) {
            const aliasName = `${objectName}.${property}`;
            if (!out.has(aliasName)) {
              out.add(aliasName);
              changed = true;
            }
          }
        }
      }
      if (objectSpan.end > objectAliasRe.lastIndex) objectAliasRe.lastIndex = objectSpan.end;
      objectAlias = objectAliasRe.exec(scan);
    }
    for (const factory of Array.from(out)) {
      const parts = String(factory || '').split('.');
      if (parts.length < 2 || !parts.every((part) => new RegExp(`^(?:this|${IDENTIFIER_PATTERN.source})$`, 'u').test(part))) continue;
      const owner = parts.slice(0, -1).join('.');
      const property = parts[parts.length - 1];
      const destructureRe = new RegExp(`\\b(const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${expressionReferencePattern(owner)}\\b`, 'gu');
      let destructure = destructureRe.exec(scan);
      while (destructure) {
        const kind = destructure[1];
        for (const aliasName of collectDestructuredStaticPropertyAliases(destructure[2] || '', property)) {
          if (!out.has(aliasName)
            && !referenceIsShadowed(factory, destructure.index)
            && (kind === 'const' || !bindingIsReassigned(text, aliasName, destructureRe.lastIndex))) {
            out.add(aliasName);
            changed = true;
          }
        }
        destructure = destructureRe.exec(scan);
      }
    }
  }
  return out;
}

function routeKeyExpressionPattern(aliases = new Set()) {
  const aliasExpression = aliasExpressionPattern(aliases);
  const core = aliasExpression
    ? `(?:${ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE}|${aliasExpression})`
    : ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE;
  return `(?:\\(\\s*)*${core}(?:\\s*\\))*`;
}

function urlSearchParamsInitializerHasRouteKey(args, aliases = new Set()) {
  const text = stripWrappingParentheses(args);
  const passThroughCall = text.match(/^(?:Object\s*\.\s*(?:entries|fromEntries)|Array\s*\.\s*from)\s*\(/u);
  if (passThroughCall) {
    const parsed = extractCallArgs(text, passThroughCall[0].length);
    return urlSearchParamsInitializerHasRouteKey(parsed.args, aliases);
  }
  const mapCall = text.match(/^new\s+Map\s*\(/u);
  if (mapCall) {
    const parsed = extractCallArgs(text, mapCall[0].length);
    return urlSearchParamsInitializerHasRouteKey(parsed.args, aliases);
  }
  if (text.startsWith('{')) {
    if (ROUTE_KEY_OBJECT_INIT_PATTERN.test(text) || ROUTE_KEY_OBJECT_SHORTHAND_PATTERN.test(text)) return true;
    const routeKeyExpression = routeKeyExpressionPattern(aliases);
    if (new RegExp(`(?:^|[,\\{]\\s*)\\[\\s*(?:${routeKeyExpression})\\s*\\]\\s*:`).test(text)) return true;
    const body = text.endsWith('}') ? text.slice(1, -1) : text.slice(1);
    return splitTopLevelArgs(body).some((part) => {
      const computed = String(part || '').trim().match(/^\[([\s\S]+?)\]\s*:/u);
      return Boolean(computed && sourceArgIsRouteKey(computed[1], aliases));
    });
  }
  if (text.startsWith('[')) {
    if (ROUTE_KEY_ARRAY_INIT_PATTERN.test(text)) return true;
    const routeKeyExpression = routeKeyExpressionPattern(aliases);
    if (new RegExp(`\\[\\s*(?:${routeKeyExpression})\\s*,`).test(text)) return true;
    const body = text.endsWith(']') ? text.slice(1, -1) : text.slice(1);
    return splitTopLevelArgs(body).some((part) => {
      const tuple = stripWrappingParentheses(part);
      if (!tuple.startsWith('[')) return false;
      const inner = tuple.endsWith(']') ? tuple.slice(1, -1) : tuple.slice(1);
      const [key] = splitTopLevelArgs(inner);
      return sourceArgIsRouteKey(key, aliases);
    });
  }
  if (/^(['"`])(?:tab|id)\s*=/u.test(text)) return true;
  if (/^(['"`])(?:tab|id)\1\s*\+\s*(['"`])=\2/u.test(text)) return true;
  const routeKeyExpression = routeKeyExpressionPattern(aliases);
  return new RegExp(`^(?:${routeKeyExpression})\\s*\\+\\s*(['"\`])=\\1`, 'u').test(text)
    || new RegExp(`^\`\\s*\\$\\{\\s*(?:${routeKeyExpression})\\s*\\}\\s*=`, 'u').test(text);
}

function urlSearchParamsExpressionArgs(expression, constructorAliases = new Set()) {
  const text = stripWrappingParentheses(expression);
  const match = text.match(new RegExp(`^new\\s+(?:${urlSearchParamsConstructorPattern(constructorAliases)})\\s*\\(`, 'u'));
  if (!match) return null;
  return extractCallArgs(text, match[0].length).args;
}

function expressionContainsRouteQueryBuilder(expression, aliases = new Set(), constructorAliases = new Set()) {
  const text = String(expression || '');
  const re = new RegExp(`\\bnew\\s+(?:${urlSearchParamsConstructorPattern(constructorAliases)})\\s*\\(`, 'gu');
  let match = re.exec(text);
  while (match) {
    const parsed = extractCallArgs(text, re.lastIndex);
    if (urlSearchParamsInitializerHasRouteKey(parsed.args, aliases)) return true;
    if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
    match = re.exec(text);
  }
  return false;
}

function expressionContainsRouteQueryStringBuilder(expression, aliases = new Set()) {
  const text = String(expression || '');
  if (/(?:^|[^\w$])(['"`])(?:tab|id)=/u.test(text)) return true;
  const routeKeyExpression = routeKeyExpressionPattern(aliases);
  if (new RegExp(`(?:${routeKeyExpression})\\s*\\+\\s*(['"\`])=\\1`, 'u').test(text)
    || new RegExp(`\\$\\{\\s*(?:${routeKeyExpression})\\s*\\}\\s*=`, 'u').test(text)) {
    return true;
  }
  const parts = splitTopLevelConcatParts(text);
  if (parts.length >= 2) {
    let staticPrefix = '';
    for (const part of parts) {
      const partValue = staticStringExpressionValue(part);
      if (partValue == null) break;
      staticPrefix += partValue;
      if (/^(?:tab|id)=/u.test(staticPrefix)) return true;
    }
    const first = staticStringExpressionValue(parts[0]);
    const second = staticStringExpressionValue(parts[1]);
    if (/^(?:tab|id)=/u.test(first || '')) return true;
    if (/^(?:tab|id)$/u.test(first || '') && String(second || '').startsWith('=')) return true;
  }
  return false;
}

function expressionBuildsRouteQuery(expression, aliases = new Set(), queryAliases = new Set(), constructorAliases = new Set()) {
  const text = stripWrappingParentheses(expression);
  if (!text) return false;
  if (urlSearchParamsInitializerHasRouteKey(text, aliases)
    || expressionIsQueryAliasReference(text, queryAliases)) return true;
  const paramsArgs = urlSearchParamsExpressionArgs(text, constructorAliases);
  if (paramsArgs != null) return urlSearchParamsInitializerHasRouteKey(paramsArgs, aliases);
  if (expressionContainsRouteQueryBuilder(text, aliases, constructorAliases)) return true;
  if (expressionContainsRouteQueryStringBuilder(text, aliases)) return true;
  const stringCall = text.match(/^String\s*\(/u);
  if (stringCall) {
    const parsed = extractCallArgs(text, stringCall[0].length);
    return expressionBuildsRouteQuery(parsed.args, aliases, queryAliases, constructorAliases);
  }
  return false;
}

function collectParamsSerializationAliases(source, name) {
  const text = String(source || '');
  const namePattern = expressionReferencePattern(name);
  const aliases = new Set();
  const sourcePattern = `(?:${namePattern}(?:\\s*\\.\\s*toString\\s*\\(\\s*\\))?|String\\s*\\(\\s*${namePattern}\\s*\\))`;
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*${sourcePattern}\\s*;?`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*${sourcePattern}\\s*;?`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      if (match[1] !== name) aliases.add(match[1]);
      match = re.exec(text);
    }
  });
  return aliases;
}

function containsRelativeParamsSerialization(source, name, seen = new Set(), externalAliases = null) {
  const text = String(source || '');
  if (seen.has(name)) return false;
  seen.add(name);
  const namePattern = expressionReferencePattern(name);
  const serializedPattern = `(?:${namePattern}(?:\\b|\\s*\\.\\s*toString\\s*\\(\\s*\\))|String\\s*\\(\\s*${namePattern}\\s*\\))`;
  const concatRe = new RegExp(`(['"\`])((?:\\\\[\\s\\S]|(?!\\1)[\\s\\S])*?[?&])\\1\\s*\\+\\s*${serializedPattern}`, 'gu');
  let match = concatRe.exec(text);
  while (match) {
    const content = match[2];
    const queryIndex = Math.max(content.lastIndexOf('?'), content.lastIndexOf('&'));
    const prefix = queryIndex >= 0 ? routeCandidatePrefix(content, queryIndex) : '';
    if (!isExternalUrlPrefix(prefix) && !inlineParamsConcatHasExternalPrefix(text, match, externalAliases)) return true;
    match = concatRe.exec(text);
  }
  const templateRe = new RegExp(`\`((?:\\\\[\\s\\S]|(?!\`)[\\s\\S])*?[?&])\\$\\{\\s*${serializedPattern}\\s*\\}`, 'gu');
  match = templateRe.exec(text);
  while (match) {
    if (!templateRouteContentHasExternalPrefix(text, match[1], externalAliases)) return true;
    match = templateRe.exec(text);
  }
  const locationSearchRe = new RegExp(`${locationSearchWritePattern(collectLocationAliases(text)).source}\\s*${serializedPattern}`, 'gu');
  if (locationSearchRe.test(text)) return true;
  for (const alias of collectParamsSerializationAliases(text, name)) {
    if (containsRelativeParamsSerialization(text, alias, seen, externalAliases)) return true;
  }
  return false;
}

function containsForbiddenUrlSearchParamsVariable(source, aliases, externalAliases = null) {
  const text = String(source || '');
  const vars = collectUrlSearchParamsVariables(text);
  for (const name of vars) {
    if (containsRouteKeyWriteForOwner(text, name, aliases) && containsRelativeParamsSerialization(text, name, new Set(), externalAliases)) {
      return true;
    }
  }
  return false;
}

function containsForbiddenUrlSearchParamsInitializer(source, aliases = new Set(), externalAliases = null) {
  const text = String(source || '');
  const initializers = collectUrlSearchParamsInitializers(text);
  for (const { name, args } of initializers) {
    if (urlSearchParamsInitializerHasRouteKey(args, aliases) && containsRelativeParamsSerialization(text, name, new Set(), externalAliases)) {
      return true;
    }
  }
  return false;
}

function collectRouteQueryAliases(source, aliases = new Set(), constructorAliases = collectUrlSearchParamsConstructorAliases(source)) {
  const text = String(source || '');
  const out = new Set();
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=`, 'gu'),
    new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_PATTERN_SOURCE})\\s*=`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      const expression = extractAssignmentExpression(text, re.lastIndex);
      if (expressionBuildsRouteQuery(expression, aliases, out, constructorAliases)) out.add(match[1]);
      match = re.exec(text);
    }
  });
  return out;
}

function expressionIsQueryAliasReference(expression, queryAliases = new Set()) {
  const patterns = Array.from(queryAliases || []).map((alias) => `(?:\\(\\s*)*${expressionReferencePattern(alias)}(?:\\s*\\))*`);
  if (!patterns.length) return false;
  const reference = `(?:${patterns.join('|')})`;
  return new RegExp(`^(?:${reference}(?:\\s*\\.\\s*toString\\s*\\(\\s*\\))?|String\\s*\\(\\s*${reference}\\s*\\))$`, 'u').test(String(expression || '').trim());
}

function containsRelativeQueryAliasSerialization(source, queryAliases = new Set(), externalAliases = null) {
  for (const alias of queryAliases || []) {
    if (containsRelativeParamsSerialization(source, alias, new Set(), externalAliases)) return true;
  }
  return false;
}

function inlineParamsConcatHasExternalPrefix(text, literalMatch, externalAliases = null) {
  const content = String(literalMatch[2] || '');
  const queryIndex = Math.max(content.lastIndexOf('?'), content.lastIndexOf('&'));
  const prefix = queryIndex >= 0 ? routeCandidatePrefix(content, queryIndex) : '';
  if (isExternalUrlPrefix(prefix)) return true;
  const before = String(text || '').slice(0, literalMatch.index);
  const literalPrefix = before.match(/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\+\s*$/u);
  if (literalPrefix && isExternalUrlPrefix(literalPrefix[2])) return true;
  const aliasPrefix = before.match(/\b([A-Za-z_$][\w$]*)\s*\+\s*$/u);
  if (aliasPrefix) {
    const aliases = externalAliases || collectExternalUrlAliases(text);
    if (aliases.has(aliasPrefix[1])) return true;
  }
  return false;
}

function templateRouteContentHasExternalPrefix(source, content, externalAliases = null) {
  const value = String(content || '');
  const queryIndex = Math.max(value.lastIndexOf('?'), value.lastIndexOf('&'));
  const prefix = queryIndex >= 0 ? routeCandidatePrefix(value, queryIndex) : '';
  if (isExternalUrlPrefix(prefix)) return true;
  const beforeQuery = queryIndex >= 0 ? value.slice(0, queryIndex).trim() : '';
  const aliasPrefix = beforeQuery.match(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/u);
  if (!aliasPrefix) return false;
  const aliases = externalAliases || collectExternalUrlAliases(source);
  return aliases.has(aliasPrefix[1]);
}

function inlineUrlSearchParamsHasRelativeSink(source, callStart, externalAliases = null) {
  const text = String(source || '');
  const before = text.slice(0, callStart);
  const concat = before.match(/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?[?&])\1\s*\+\s*\(?\s*$/u);
  if (concat) {
    concat.index = before.length - concat[0].length;
    return !inlineParamsConcatHasExternalPrefix(text, concat, externalAliases);
  }
  const template = before.match(/`((?:\\[\s\S]|(?!`)[\s\S])*?[?&])\$\{\s*$/u);
  if (template) {
    return !templateRouteContentHasExternalPrefix(text, template[1], externalAliases);
  }
  return new RegExp(`${locationSearchWritePattern(collectLocationAliases(text)).source}\\s*$`, 'u').test(before);
}

function containsForbiddenInlineUrlSearchParamsInitializer(source, aliases = new Set(), externalAliases = null) {
  const text = String(source || '');
  const constructorAliases = collectUrlSearchParamsConstructorAliases(text);
  const re = new RegExp(`\\bnew\\s+(?:${urlSearchParamsConstructorPattern(constructorAliases)})\\s*\\(`, 'gu');
  let match = re.exec(text);
  while (match) {
    const parsed = extractCallArgs(text, re.lastIndex);
    if (urlSearchParamsInitializerHasRouteKey(parsed.args, aliases)
      && inlineUrlSearchParamsHasRelativeSink(text, match.index, externalAliases)) {
      return true;
    }
    if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
    match = re.exec(text);
  }
  return false;
}

function splitRouteQueryHasExternalPrefix(text, match, externalAliases = null) {
  const content = String(match[2] || '');
  const queryIndex = Math.max(content.lastIndexOf('?'), content.lastIndexOf('&'));
  const prefix = queryIndex >= 0 ? routeCandidatePrefix(content, queryIndex) : '';
  if (isExternalUrlPrefix(prefix)) return true;
  const before = String(text || '').slice(0, match.index);
  const literalPrefix = before.match(/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\+\s*$/u);
  if (literalPrefix && isExternalUrlPrefix(literalPrefix[2])) return true;
  const aliasPrefix = before.match(/\b([A-Za-z_$][\w$]*)\s*\+\s*$/u);
  if (aliasPrefix) {
    const aliases = externalAliases || collectExternalUrlAliases(text);
    if (aliases.has(aliasPrefix[1])) return true;
  }
  return false;
}

function containsForbiddenSplitRouteQueryLiteral(source, externalAliases = null, aliases = new Set()) {
  const text = String(source || '');
  SPLIT_ROUTE_QUERY_LITERAL_PATTERN.lastIndex = 0;
  let match = SPLIT_ROUTE_QUERY_LITERAL_PATTERN.exec(text);
  while (match) {
    if (!splitRouteQueryHasExternalPrefix(text, match, externalAliases)) return true;
    match = SPLIT_ROUTE_QUERY_LITERAL_PATTERN.exec(text);
  }
  const splitPrefixRe = /(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?[?&])\1\s*\+\s*/gu;
  match = splitPrefixRe.exec(text);
  while (match) {
    if (!splitRouteQueryHasExternalPrefix(text, match, externalAliases)) {
      const expression = extractAssignmentExpression(text, splitPrefixRe.lastIndex);
      if (expressionBuildsRouteQuery(expression, aliases)) return true;
    }
    match = splitPrefixRe.exec(text);
  }
  return false;
}

function containsForbiddenRouteKeyAliasConstruction(source, aliases = new Set(), externalAliases = null) {
  const routeKeyExpression = routeKeyExpressionPattern(aliases);
  const text = String(source || '');
  const concatRe = new RegExp(`(['"\`])((?:\\\\[\\s\\S]|(?!\\1)[\\s\\S])*?[?&])\\1\\s*\\+\\s*(?:${routeKeyExpression})\\s*\\+\\s*(['"\`])=\\3`, 'gu');
  let match = concatRe.exec(text);
  while (match) {
    if (!inlineParamsConcatHasExternalPrefix(text, match, externalAliases)) return true;
    match = concatRe.exec(text);
  }
  const templateRe = new RegExp(`\`((?:\\\\[\\s\\S]|(?!\`)[\\s\\S])*?[?&])\\$\\{\\s*(?:${routeKeyExpression})\\s*\\}\\s*=`, 'gu');
  match = templateRe.exec(text);
  while (match) {
    if (!templateRouteContentHasExternalPrefix(text, match[1], externalAliases)) return true;
    match = templateRe.exec(text);
  }
  return false;
}

function expressionIsExternalUrl(value, aliases = new Set()) {
  const text = stripWrappingParentheses(value);
  const match = text.match(/^(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/u);
  if (match) {
    if (isExternalUrlPrefix(match[2]) || aliases.has(match[2])) return true;
    const aliasExpression = aliasExpressionPattern(aliases);
    return match[1] === '`' && aliasExpression
      ? new RegExp(`^\\s*\\$\\{\\s*(?:${aliasExpression})\\s*\\}`, 'u').test(match[2])
      : false;
  }
  if (aliases.has(text)) return true;
  const aliasExpression = aliasExpressionPattern(aliases);
  if (!aliasExpression) return false;
  return new RegExp(`^(?:${aliasExpression})\\s*\\+`, 'u').test(text)
    || new RegExp(`^\`\\s*\\$\\{\\s*(?:${aliasExpression})\\s*\\}`, 'u').test(text);
}

function expressionIsStaticRelativeUrl(value, aliases = new Set()) {
  const text = stripWrappingParentheses(value);
  const aliasExpression = aliasExpressionPattern(aliases);
  if (aliasExpression && new RegExp(`^(?:${aliasExpression})$`, 'u').test(text)) return true;
  const match = text.match(/^(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1$/u);
  if (match) return !isExternalUrlPrefix(match[2]);
  const concatPrefix = text.match(/^(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\+/u);
  return Boolean(concatPrefix && !isExternalUrlPrefix(concatPrefix[2]));
}

function urlConstructorArgsAreExternal(args, aliases = new Set(), staticRelativeAliases = new Set()) {
  const parts = splitTopLevelArgs(args);
  if (expressionIsExternalUrl(parts[0], aliases)) return true;
  return parts.length > 1
    && expressionIsStaticRelativeUrl(parts[0], staticRelativeAliases)
    && expressionIsExternalUrl(parts[1], aliases);
}

function collectRouteUrlFactoryAliases(source, externalAliases = collectExternalUrlAliases(source), staticRelativeAliases = collectStaticRelativeUrlAliases(source)) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const out = new Set();
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const addFactoryAlias = (name, index) => {
    if (braceDepthAt(text, index) === 0) out.add(name);
  };
  const scopedUrlAliases = (body, paramsText = '', offset = null) => {
    const scopedExternalAliases = new Set(externalAliases);
    const scopedStaticRelativeAliases = new Set(staticRelativeAliases);
    const bindings = new Set();
    addBindingNamesFromPattern(bindings, paramsText);
    if (offset == null) addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    else addVisibleLocalDeclarationBindings(bindings, body, offset);
    bindings.forEach((name) => {
      scopedExternalAliases.delete(name);
      scopedStaticRelativeAliases.delete(name);
    });
    return { scopedExternalAliases, scopedStaticRelativeAliases };
  };
  const bodyReturnsRouteUrl = (body, paramsText = '') => {
    const nestedFunctionRanges = collectNestedFunctionBodyRanges(body);
    const routeUrlVariables = new Map();
    const variableRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
    let variable = variableRe.exec(body);
    while (variable) {
      if (indexIsInsideRange(variable.index, nestedFunctionRanges)) {
        variable = variableRe.exec(body);
        continue;
      }
      const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases(body, paramsText, variable.index);
      const parsed = extractCallArgs(body, variableRe.lastIndex);
      if (!urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases)) {
        routeUrlVariables.set(variable[2], { kind: variable[1], end: parsed.end });
      }
      if (parsed.end > variableRe.lastIndex) variableRe.lastIndex = parsed.end;
      variable = variableRe.exec(body);
    }
    const returnedAliasRe = new RegExp(`\\breturn\\s+(?:\\(\\s*)*(${IDENTIFIER_PATTERN.source})(?:\\s*\\))*\\s*;?`, 'gu');
    let returnedAlias = returnedAliasRe.exec(body);
    while (returnedAlias) {
      if (indexIsInsideRange(returnedAlias.index, nestedFunctionRanges)) {
        returnedAlias = returnedAliasRe.exec(body);
        continue;
      }
      const routeUrlVariable = routeUrlVariables.get(returnedAlias[1]);
      if (routeUrlVariable
        && (routeUrlVariable.kind === 'const'
          || !bindingIsReassigned(body.slice(0, returnedAlias.index), returnedAlias[1], routeUrlVariable.end))) {
        return true;
      }
      returnedAlias = returnedAliasRe.exec(body);
    }
    const re = new RegExp(`\\breturn\\s+(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
    let match = re.exec(body);
    while (match) {
      if (indexIsInsideRange(match.index, nestedFunctionRanges)) {
        match = re.exec(body);
        continue;
      }
      const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases(body, paramsText, match.index);
      const parsed = extractCallArgs(body, re.lastIndex);
      if (!urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases)) return true;
      if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
      match = re.exec(body);
    }
    return false;
  };
  const expressionReturnsRouteUrl = (expression, paramsText = '') => {
    const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases('', paramsText);
    const value = stripWrappingParentheses(expression);
    const match = value.match(new RegExp(`^new\\s+(?:${constructorPattern})\\s*\\(`, 'u'));
    if (!match) return false;
    const parsed = extractCallArgs(value, match[0].length);
    return !urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases);
  };
  const functionRe = new RegExp(`\\b(?:async\\s+)?function\\s+(${IDENTIFIER_PATTERN.source})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  let match = functionRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, functionRe.lastIndex - 1), match[2])) addFactoryAlias(match[1], match.index);
    match = functionRe.exec(scan);
  }
  const functionExpressionRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = functionExpressionRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, functionExpressionRe.lastIndex - 1), match[2])) addFactoryAlias(match[1], match.index);
    match = functionExpressionRe.exec(scan);
  }
  const arrowBlockRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`, 'gu');
  match = arrowBlockRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, arrowBlockRe.lastIndex - 1), match[2])) addFactoryAlias(match[1], match.index);
    match = arrowBlockRe.exec(scan);
  }
  const arrowExpressionRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*`, 'gu');
  match = arrowExpressionRe.exec(scan);
  while (match) {
    const expression = extractAssignmentExpression(text, arrowExpressionRe.lastIndex);
    if (expressionReturnsRouteUrl(expression, match[2])) addFactoryAlias(match[1], match.index);
    arrowExpressionRe.lastIndex += expression.length;
    match = arrowExpressionRe.exec(scan);
  }
  const singleArrowBlockRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*=>\\s*\\{`, 'gu');
  match = singleArrowBlockRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, singleArrowBlockRe.lastIndex - 1), match[2])) addFactoryAlias(match[1], match.index);
    match = singleArrowBlockRe.exec(scan);
  }
  const singleArrowExpressionRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*=>\\s*`, 'gu');
  match = singleArrowExpressionRe.exec(scan);
  while (match) {
    const expression = extractAssignmentExpression(text, singleArrowExpressionRe.lastIndex);
    if (expressionReturnsRouteUrl(expression, match[2])) addFactoryAlias(match[1], match.index);
    singleArrowExpressionRe.lastIndex += expression.length;
    match = singleArrowExpressionRe.exec(scan);
  }
  const scanObjectRouteFactoryMembers = (baseName, objectBody, objectBodyStart, objectIndex) => {
    const objectBodyScan = maskNonCodeForRouteGuard(objectBody);
    const memberIsTopLevel = (index) => braceDepthAt(objectBody, index) === 0;
    const memberIsScannable = (index) => (
      (index === 0 || objectBodyScan[index] === ',')
      && memberIsTopLevel(index)
    );
    const methodRe = new RegExp(`(?:^|[,\\{])\\s*(?:async\\s+)?(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let method = methodRe.exec(objectBody);
    while (method) {
      if (!memberIsScannable(method.index)) {
        method = methodRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(method[1]);
      const methodOpenBrace = objectBodyStart + methodRe.lastIndex - 1;
      if (property && bodyReturnsRouteUrl(extractBlockText(text, methodOpenBrace), method[2])) {
        addFactoryAlias(`${baseName}.${property}`, objectIndex);
      }
      const methodSpan = extractBlockSpan(text, methodOpenBrace);
      methodRe.lastIndex = Math.max(methodRe.lastIndex, methodSpan.end - objectBodyStart);
      method = methodRe.exec(objectBody);
    }
    const propertyFunctionRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let propertyFunction = propertyFunctionRe.exec(objectBody);
    while (propertyFunction) {
      if (!memberIsScannable(propertyFunction.index)) {
        propertyFunction = propertyFunctionRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyFunction[1]);
      const functionOpenBrace = objectBodyStart + propertyFunctionRe.lastIndex - 1;
      if (property && bodyReturnsRouteUrl(extractBlockText(text, functionOpenBrace), propertyFunction[2])) {
        addFactoryAlias(`${baseName}.${property}`, objectIndex);
      }
      const functionSpan = extractBlockSpan(text, functionOpenBrace);
      propertyFunctionRe.lastIndex = Math.max(propertyFunctionRe.lastIndex, functionSpan.end - objectBodyStart);
      propertyFunction = propertyFunctionRe.exec(objectBody);
    }
    const propertyArrowRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*`, 'gu');
    let propertyArrow = propertyArrowRe.exec(objectBody);
    while (propertyArrow) {
      if (!memberIsScannable(propertyArrow.index)) {
        propertyArrow = propertyArrowRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyArrow[1]);
      const params = propertyArrow[2] || propertyArrow[3] || '';
      const valueStart = objectBodyStart + propertyArrowRe.lastIndex;
      if (text[valueStart] === '{') {
        const arrowSpan = extractBlockSpan(text, valueStart);
        if (property && bodyReturnsRouteUrl(arrowSpan.body, params)) addFactoryAlias(`${baseName}.${property}`, objectIndex);
        propertyArrowRe.lastIndex = Math.max(propertyArrowRe.lastIndex, arrowSpan.end - objectBodyStart);
      } else {
        const expression = extractAssignmentExpression(text, valueStart);
        if (property && expressionReturnsRouteUrl(expression, params)) addFactoryAlias(`${baseName}.${property}`, objectIndex);
        propertyArrowRe.lastIndex += expression.length;
      }
      propertyArrow = propertyArrowRe.exec(objectBody);
    }
    const propertyObjectRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*\\{`, 'gu');
    let propertyObject = propertyObjectRe.exec(objectBody);
    while (propertyObject) {
      if (!memberIsScannable(propertyObject.index)) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyObject[1]);
      const nestedOpenBrace = text.indexOf('{', objectBodyStart + propertyObject.index);
      if (!property || nestedOpenBrace < 0) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const nestedSpan = extractBlockSpan(text, nestedOpenBrace);
      scanObjectRouteFactoryMembers(`${baseName}.${property}`, nestedSpan.body, nestedOpenBrace + 1, objectIndex);
      propertyObjectRe.lastIndex = Math.max(propertyObjectRe.lastIndex, nestedSpan.end - objectBodyStart);
      propertyObject = propertyObjectRe.exec(objectBody);
    }
  };
  const defaultExportedIdentifierNames = (() => {
    const names = new Set();
    const defaultIdentifierRe = new RegExp(`\\bexport\\s+default\\s*(?:\\(\\s*)*(${IDENTIFIER_PATTERN.source})(?:\\s*\\))*\\s*;?`, 'gu');
    let defaultIdentifier = defaultIdentifierRe.exec(scan);
    while (defaultIdentifier) {
      names.add(defaultIdentifier[1]);
      defaultIdentifier = defaultIdentifierRe.exec(scan);
    }
    const localDefaultExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
    let localDefaultExport = localDefaultExportRe.exec(scan);
    while (localDefaultExport) {
      const after = scan.slice(localDefaultExportRe.lastIndex);
      if (/^\s*from\b/u.test(after)) {
        localDefaultExport = localDefaultExportRe.exec(scan);
        continue;
      }
      (localDefaultExport[1] || '').split(',').forEach((part) => {
        const spec = part.trim();
        const alias = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
        if (alias && alias[2] === 'default') names.add(alias[1]);
      });
      localDefaultExport = localDefaultExportRe.exec(scan);
    }
    return names;
  })();
  const objectLiteralRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*\\{`, 'gu');
  match = objectLiteralRe.exec(scan);
  while (match) {
    const objectName = match[1];
    const objectSpan = extractBlockSpan(text, objectLiteralRe.lastIndex - 1);
    scanObjectRouteFactoryMembers(objectName, objectSpan.body, objectLiteralRe.lastIndex, match.index);
    if (defaultExportedIdentifierNames.has(objectName)) {
      scanObjectRouteFactoryMembers('this', objectSpan.body, objectLiteralRe.lastIndex, match.index);
    }
    if (objectSpan.end > objectLiteralRe.lastIndex) objectLiteralRe.lastIndex = objectSpan.end;
    match = objectLiteralRe.exec(scan);
  }
  const defaultObjectRe = /\bexport\s+default\s*(?:\(\s*)*\{/gu;
  match = defaultObjectRe.exec(scan);
  while (match) {
    const objectSpan = extractBlockSpan(text, defaultObjectRe.lastIndex - 1);
    scanObjectRouteFactoryMembers('this', objectSpan.body, defaultObjectRe.lastIndex, match.index);
    if (objectSpan.end > defaultObjectRe.lastIndex) defaultObjectRe.lastIndex = objectSpan.end;
    match = defaultObjectRe.exec(scan);
  }
  const defaultParenthesizedFunctionRe = new RegExp(`\\bexport\\s+default\\s*(?:\\(\\s*)+(?:async\\s+)?function(?:\\s+${IDENTIFIER_PATTERN.source})?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = defaultParenthesizedFunctionRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, defaultParenthesizedFunctionRe.lastIndex - 1), match[1])) out.add('default');
    match = defaultParenthesizedFunctionRe.exec(scan);
  }
  const defaultFunctionRe = new RegExp(`\\bexport\\s+default\\s+(?:async\\s+)?function(?:\\s+${IDENTIFIER_PATTERN.source})?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = defaultFunctionRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, defaultFunctionRe.lastIndex - 1), match[1])) out.add('default');
    match = defaultFunctionRe.exec(scan);
  }
  const defaultParenthesizedArrowBlockRe = new RegExp(`\\bexport\\s+default\\s*(?:\\(\\s*)+(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*\\{`, 'gu');
  match = defaultParenthesizedArrowBlockRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, defaultParenthesizedArrowBlockRe.lastIndex - 1), match[1] || match[2] || '')) out.add('default');
    match = defaultParenthesizedArrowBlockRe.exec(scan);
  }
  const defaultArrowBlockRe = new RegExp(`\\bexport\\s+default\\s+(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*\\{`, 'gu');
  match = defaultArrowBlockRe.exec(scan);
  while (match) {
    if (bodyReturnsRouteUrl(extractBlockText(text, defaultArrowBlockRe.lastIndex - 1), match[1] || match[2] || '')) out.add('default');
    match = defaultArrowBlockRe.exec(scan);
  }
  const defaultParenthesizedArrowExpressionRe = new RegExp(`\\bexport\\s+default\\s*(?:\\(\\s*)+(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*`, 'gu');
  match = defaultParenthesizedArrowExpressionRe.exec(scan);
  while (match) {
    if (scan[defaultParenthesizedArrowExpressionRe.lastIndex] !== '{') {
      const expression = extractAssignmentExpression(text, defaultParenthesizedArrowExpressionRe.lastIndex);
      if (expressionReturnsRouteUrl(expression, match[1] || match[2] || '')) out.add('default');
      defaultParenthesizedArrowExpressionRe.lastIndex += expression.length;
    }
    match = defaultParenthesizedArrowExpressionRe.exec(scan);
  }
  const defaultArrowExpressionRe = new RegExp(`\\bexport\\s+default\\s+(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*`, 'gu');
  match = defaultArrowExpressionRe.exec(scan);
  while (match) {
    if (scan[defaultArrowExpressionRe.lastIndex] !== '{') {
      const expression = extractAssignmentExpression(text, defaultArrowExpressionRe.lastIndex);
      if (expressionReturnsRouteUrl(expression, match[1] || match[2] || '')) out.add('default');
      defaultArrowExpressionRe.lastIndex += expression.length;
    }
    match = defaultArrowExpressionRe.exec(scan);
  }
  const defaultIdentifierRe = new RegExp(`\\bexport\\s+default\\s*(?:\\(\\s*)*(${IDENTIFIER_PATTERN.source})(?:\\s*\\))*\\s*;?`, 'gu');
  match = defaultIdentifierRe.exec(scan);
  while (match) {
    if (out.has(match[1])) out.add('default');
    match = defaultIdentifierRe.exec(scan);
  }
  const localDefaultExportRe = /\bexport\s*\{([\s\S]*?)\}/gu;
  match = localDefaultExportRe.exec(scan);
  while (match) {
    const after = scan.slice(localDefaultExportRe.lastIndex);
    if (/^\s*from\b/u.test(after)) {
      match = localDefaultExportRe.exec(scan);
      continue;
    }
    (match[1] || '').split(',').forEach((part) => {
      const spec = part.trim();
      const alias = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
      if (alias && alias[2] === 'default' && out.has(alias[1])) out.add('default');
    });
    match = localDefaultExportRe.exec(scan);
  }
  return out;
}

function containsForbiddenScopedRouteUrlFactoryMutation(source, aliases, externalAliases, staticRelativeAliases) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const containingBlockSpan = (index) => {
    const stack = blockStackAt(text, index);
    const open = stack.length ? stack[stack.length - 1] : -1;
    if (open < 0) return { start: 0, end: text.length };
    const span = extractBlockSpan(text, open);
    return { start: open + 1, end: Math.max(open + 1, span.end - 1) };
  };
  const containingFunctionSpan = (index) => {
    const stack = blockStackAt(text, index);
    const controlBlockNames = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const open = stack[i];
      const before = text.slice(Math.max(0, open - 160), open);
      const methodBlock = before.match(/(?:^|[,{]\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/u);
      if (/\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*$/u.test(before)
        || /=>\s*$/u.test(before)
        || (methodBlock && !controlBlockNames.has(methodBlock[1]))) {
        const span = extractBlockSpan(text, open);
        return { start: open + 1, end: Math.max(open + 1, span.end - 1) };
      }
    }
    return { start: 0, end: text.length };
  };
  const scopedUrlAliases = (body, paramsText = '', offset = null) => {
    const scopedExternalAliases = new Set(externalAliases);
    const scopedStaticRelativeAliases = new Set(staticRelativeAliases);
    const bindings = new Set();
    addBindingNamesFromPattern(bindings, paramsText);
    if (offset == null) addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
    else addVisibleLocalDeclarationBindings(bindings, body, offset);
    bindings.forEach((name) => {
      scopedExternalAliases.delete(name);
      scopedStaticRelativeAliases.delete(name);
    });
    return { scopedExternalAliases, scopedStaticRelativeAliases };
  };
  const bodyReturnsRouteUrl = (body, paramsText = '') => {
    const nestedFunctionRanges = collectNestedFunctionBodyRanges(body);
    const routeUrlVariables = new Map();
    const variableRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
    let variable = variableRe.exec(body);
    while (variable) {
      if (indexIsInsideRange(variable.index, nestedFunctionRanges)) {
        variable = variableRe.exec(body);
        continue;
      }
      const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases(body, paramsText, variable.index);
      const parsed = extractCallArgs(body, variableRe.lastIndex);
      if (!urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases)) {
        routeUrlVariables.set(variable[2], { kind: variable[1], end: parsed.end });
      }
      if (parsed.end > variableRe.lastIndex) variableRe.lastIndex = parsed.end;
      variable = variableRe.exec(body);
    }
    const returnedAliasRe = new RegExp(`\\breturn\\s+(?:\\(\\s*)*(${IDENTIFIER_PATTERN.source})(?:\\s*\\))*\\s*;?`, 'gu');
    let returnedAlias = returnedAliasRe.exec(body);
    while (returnedAlias) {
      if (indexIsInsideRange(returnedAlias.index, nestedFunctionRanges)) {
        returnedAlias = returnedAliasRe.exec(body);
        continue;
      }
      const routeUrlVariable = routeUrlVariables.get(returnedAlias[1]);
      if (routeUrlVariable
        && (routeUrlVariable.kind === 'const'
          || !bindingIsReassigned(body.slice(0, returnedAlias.index), returnedAlias[1], routeUrlVariable.end))) {
        return true;
      }
      returnedAlias = returnedAliasRe.exec(body);
    }
    const re = new RegExp(`\\breturn\\s+(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
    let match = re.exec(body);
    while (match) {
      if (indexIsInsideRange(match.index, nestedFunctionRanges)) {
        match = re.exec(body);
        continue;
      }
      const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases(body, paramsText, match.index);
      const parsed = extractCallArgs(body, re.lastIndex);
      if (!urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases)) return true;
      if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
      match = re.exec(body);
    }
    return false;
  };
  const expressionReturnsRouteUrl = (expression, paramsText = '') => {
    const { scopedExternalAliases, scopedStaticRelativeAliases } = scopedUrlAliases('', paramsText);
    const value = stripWrappingParentheses(expression);
    const match = value.match(new RegExp(`^new\\s+(?:${constructorPattern})\\s*\\(`, 'u'));
    if (!match) return false;
    const parsed = extractCallArgs(value, match[0].length);
    return !urlConstructorArgsAreExternal(parsed.args, scopedExternalAliases, scopedStaticRelativeAliases);
  };
  const factories = [];
  const addFactory = (name, index, body, paramsText = '', scopeKind = 'block') => {
    if (braceDepthAt(text, index) === 0) return;
    if (bodyReturnsRouteUrl(body, paramsText)) factories.push({ name, scope: scopeKind === 'function' ? containingFunctionSpan(index) : containingBlockSpan(index) });
  };
  const addExpressionFactory = (name, index, expression, paramsText = '', scopeKind = 'block') => {
    if (braceDepthAt(text, index) === 0) return;
    if (expressionReturnsRouteUrl(expression, paramsText)) factories.push({ name, scope: scopeKind === 'function' ? containingFunctionSpan(index) : containingBlockSpan(index) });
  };
  const functionRe = new RegExp(`\\b(?:async\\s+)?function\\s+(${IDENTIFIER_PATTERN.source})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  let match = functionRe.exec(scan);
  while (match) {
    addFactory(match[1], match.index, extractBlockText(text, functionRe.lastIndex - 1), match[2]);
    match = functionRe.exec(scan);
  }
  const functionExpressionRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = functionExpressionRe.exec(scan);
  while (match) {
    addFactory(match[2], match.index, extractBlockText(text, functionExpressionRe.lastIndex - 1), match[3], match[1] === 'var' ? 'function' : 'block');
    match = functionExpressionRe.exec(scan);
  }
  const arrowBlockRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`, 'gu');
  match = arrowBlockRe.exec(scan);
  while (match) {
    addFactory(match[2], match.index, extractBlockText(text, arrowBlockRe.lastIndex - 1), match[3], match[1] === 'var' ? 'function' : 'block');
    match = arrowBlockRe.exec(scan);
  }
  const singleArrowBlockRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*=>\\s*\\{`, 'gu');
  match = singleArrowBlockRe.exec(scan);
  while (match) {
    addFactory(match[2], match.index, extractBlockText(text, singleArrowBlockRe.lastIndex - 1), match[3], match[1] === 'var' ? 'function' : 'block');
    match = singleArrowBlockRe.exec(scan);
  }
  const arrowExpressionRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*`, 'gu');
  match = arrowExpressionRe.exec(scan);
  while (match) {
    const expression = extractAssignmentExpression(text, arrowExpressionRe.lastIndex);
    addExpressionFactory(match[2], match.index, expression, match[3], match[1] === 'var' ? 'function' : 'block');
    arrowExpressionRe.lastIndex += expression.length;
    match = arrowExpressionRe.exec(scan);
  }
  const singleArrowExpressionRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?(${IDENTIFIER_PATTERN.source})\\s*=>\\s*`, 'gu');
  match = singleArrowExpressionRe.exec(scan);
  while (match) {
    const expression = extractAssignmentExpression(text, singleArrowExpressionRe.lastIndex);
    addExpressionFactory(match[2], match.index, expression, match[3], match[1] === 'var' ? 'function' : 'block');
    singleArrowExpressionRe.lastIndex += expression.length;
    match = singleArrowExpressionRe.exec(scan);
  }
  const scanObjectRouteFactoryMembers = (baseName, objectBody, objectBodyStart, objectIndex) => {
    const objectBodyScan = maskNonCodeForRouteGuard(objectBody);
    const memberIsTopLevel = (index) => braceDepthAt(objectBody, index) === 0;
    const memberIsScannable = (index) => (
      (index === 0 || objectBodyScan[index] === ',')
      && memberIsTopLevel(index)
    );
    const methodRe = new RegExp(`(?:^|[,\\{])\\s*(?:async\\s+)?(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let method = methodRe.exec(objectBody);
    while (method) {
      if (!memberIsScannable(method.index)) {
        method = methodRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(method[1]);
      const methodOpenBrace = objectBodyStart + methodRe.lastIndex - 1;
      const methodSpan = extractBlockSpan(text, methodOpenBrace);
      if (property) addFactory(`${baseName}.${property}`, objectIndex, methodSpan.body, method[2]);
      methodRe.lastIndex = Math.max(methodRe.lastIndex, methodSpan.end - objectBodyStart);
      method = methodRe.exec(objectBody);
    }
    const propertyFunctionRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let propertyFunction = propertyFunctionRe.exec(objectBody);
    while (propertyFunction) {
      if (!memberIsScannable(propertyFunction.index)) {
        propertyFunction = propertyFunctionRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyFunction[1]);
      const functionOpenBrace = objectBodyStart + propertyFunctionRe.lastIndex - 1;
      const functionSpan = extractBlockSpan(text, functionOpenBrace);
      if (property) addFactory(`${baseName}.${property}`, objectIndex, functionSpan.body, propertyFunction[2]);
      propertyFunctionRe.lastIndex = Math.max(propertyFunctionRe.lastIndex, functionSpan.end - objectBodyStart);
      propertyFunction = propertyFunctionRe.exec(objectBody);
    }
    const propertyArrowRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*`, 'gu');
    let propertyArrow = propertyArrowRe.exec(objectBody);
    while (propertyArrow) {
      if (!memberIsScannable(propertyArrow.index)) {
        propertyArrow = propertyArrowRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyArrow[1]);
      const params = propertyArrow[2] || propertyArrow[3] || '';
      const valueStart = objectBodyStart + propertyArrowRe.lastIndex;
      if (text[valueStart] === '{') {
        const arrowSpan = extractBlockSpan(text, valueStart);
        if (property) addFactory(`${baseName}.${property}`, objectIndex, arrowSpan.body, params);
        propertyArrowRe.lastIndex = Math.max(propertyArrowRe.lastIndex, arrowSpan.end - objectBodyStart);
      } else {
        const expression = extractAssignmentExpression(text, valueStart);
        if (property) addExpressionFactory(`${baseName}.${property}`, objectIndex, expression, params);
        propertyArrowRe.lastIndex += expression.length;
      }
      propertyArrow = propertyArrowRe.exec(objectBody);
    }
    const propertyObjectRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*\\{`, 'gu');
    let propertyObject = propertyObjectRe.exec(objectBody);
    while (propertyObject) {
      if (!memberIsScannable(propertyObject.index)) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyObject[1]);
      const nestedOpenBrace = text.indexOf('{', objectBodyStart + propertyObject.index);
      if (!property || nestedOpenBrace < 0) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const nestedSpan = extractBlockSpan(text, nestedOpenBrace);
      scanObjectRouteFactoryMembers(`${baseName}.${property}`, nestedSpan.body, nestedOpenBrace + 1, objectIndex);
      propertyObjectRe.lastIndex = Math.max(propertyObjectRe.lastIndex, nestedSpan.end - objectBodyStart);
      propertyObject = propertyObjectRe.exec(objectBody);
    }
  };
  const objectLiteralRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*\\{`, 'gu');
  match = objectLiteralRe.exec(scan);
  while (match) {
    const objectSpan = extractBlockSpan(text, objectLiteralRe.lastIndex - 1);
    scanObjectRouteFactoryMembers(match[1], objectSpan.body, objectLiteralRe.lastIndex, match.index);
    if (objectSpan.end > objectLiteralRe.lastIndex) objectLiteralRe.lastIndex = objectSpan.end;
    match = objectLiteralRe.exec(scan);
  }
  const seenFactoryScopes = new Set(factories.map((factory) => `${factory.scope.start}:${factory.scope.end}:${factory.name}`));
  for (let i = 0; i < factories.length; i += 1) {
    const { name, scope } = factories[i];
    const scopedText = text.slice(scope.start, scope.end);
    const aliasIsShadowed = (factory, scopedIndex) => referenceIsShadowedInScope(text, factory, scope, scopedIndex);
    for (const alias of expandRouteUrlFactoryAliases(scopedText, new Set([name]), { isReferenceShadowed: aliasIsShadowed })) {
      const key = `${scope.start}:${scope.end}:${alias}`;
      if (!seenFactoryScopes.has(key)) {
        seenFactoryScopes.add(key);
        factories.push({ name: alias, scope });
      }
    }
  }
  for (const { name, scope } of factories) {
    const scopedText = text.slice(scope.start, scope.end);
    const callIsShadowed = (scopedCallIndex) => {
      return referenceIsShadowedInScope(text, name, scope, scopedCallIndex);
    };
    const callableNamePattern = `(?:\\(\\s*)*${expressionReferencePatternForSource(name, scopedText)}\\s*(?:\\))*`;
    const callStartPattern = functionInvocationStartPattern(callableNamePattern);
    const parenthesizedCallStartPattern = `(?:\\(\\s*)*${callStartPattern}`;
    const vars = new Set();
    [
      new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu'),
      new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu'),
      new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE})\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu')
    ].forEach((re) => {
      let assigned = re.exec(scopedText);
      while (assigned) {
        const parsed = extractCallArgs(scopedText, re.lastIndex);
        if (!callIsShadowed(assigned.index)) vars.add(normalizeStaticMemberExpression(assigned[1]));
        if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
        assigned = re.exec(scopedText);
      }
    });
    for (const variable of vars) {
      if (containsRouteKeyWriteForOwner(scopedText, variable, aliases, 'searchParams')) return true;
      if (containsForbiddenSearchAssignment(scopedText, searchWritePatternForOwner(variable, scopedText), aliases)) return true;
      const paramsAliases = collectSearchParamsAliasesForRouteUrl(scopedText, variable);
      for (const paramsAlias of paramsAliases) {
        if (containsRouteKeyWriteForOwner(scopedText, paramsAlias, aliases)) return true;
      }
    }
    const searchParamsAccess = propertyAccessorPattern('searchParams', collectStaticStringAliases(scopedText, 'searchParams'));
    const mutator = `(?:${propertyAccessorPattern('set')}|${propertyAccessorPattern('append')}|${propertyAccessorPattern('delete')})`;
    const parenthesizedRouteKey = `(?:\\(\\s*)*(?:${IDENTIFIER_PATTERN.source}|${ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE})(?:\\s*\\))*`;
    const searchAccess = propertyAccessorPattern('search', collectStaticStringAliases(scopedText, 'search'));
    const directSearchConstructorAliases = collectUrlSearchParamsConstructorAliases(scopedText);
    const directSearchQueryAliases = collectRouteQueryAliases(scopedText, aliases, directSearchConstructorAliases);
    const factoryParamsAliases = new Set();
    const collectFactoryParamsAlias = (re) => {
      let alias = re.exec(scopedText);
      while (alias) {
        const parsed = extractCallArgs(scopedText, re.lastIndex);
        const suffix = scopedText.slice(parsed.end).match(new RegExp(`^\\s*(?:\\))*${searchParamsAccess}`, 'u'));
        if (!callIsShadowed(alias.index) && suffix) factoryParamsAliases.add(alias[1]);
        if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
        alias = re.exec(scopedText);
      }
    };
    collectFactoryParamsAlias(new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu'));
    collectFactoryParamsAlias(new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu'));
    const destructuredParamsRe = new RegExp(`\\b(?:const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*(?:await\\s+)?${parenthesizedCallStartPattern}`, 'gu');
    let destructuredParams = destructuredParamsRe.exec(scopedText);
    while (destructuredParams) {
      const parsed = extractCallArgs(scopedText, destructuredParamsRe.lastIndex);
      if (!callIsShadowed(destructuredParams.index)) {
        const body = destructuredParams[1] || '';
        for (const alias of collectDestructuredStaticPropertyAliases(body, 'searchParams')) {
          factoryParamsAliases.add(alias);
        }
      }
      if (parsed.end > destructuredParamsRe.lastIndex) destructuredParamsRe.lastIndex = parsed.end;
      destructuredParams = destructuredParamsRe.exec(scopedText);
    }
    for (const paramsAlias of factoryParamsAliases) {
      if (containsRouteKeyWriteForOwner(scopedText, paramsAlias, aliases)) return true;
    }
    const scanFactoryCallSuffix = (callIndex, callEnd) => {
      if (callIsShadowed(callIndex)) return false;
      const suffixText = scopedText.slice(callEnd);
      const directParams = suffixText.match(new RegExp(`^\\s*(?:\\))*${searchParamsAccess}${mutator}\\s*(?:\\?\\.\\s*)?\\(\\s*(${parenthesizedRouteKey}|[^,\\)]+)\\s*(?:,|\\))`, 'u'));
      if (directParams && sourceArgIsRouteKey(directParams[1], aliases)) return true;
      const dispatch = suffixText.match(new RegExp(`^\\s*(?:\\))*${searchParamsAccess}${mutator}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`, 'u'));
      if (dispatch) {
        const method = dispatch[1] || dispatch[2] || dispatch[3];
        const parsed = extractCallArgs(suffixText, dispatch[0].length);
        const parts = splitTopLevelArgs(parsed.args);
        const applyArgs = method === 'apply' ? splitTopLevelArgs((parts[1] || '').trim().replace(/^\[\s*|\s*\]$/gu, '')) : [];
        const routeKeyArg = method === 'apply' ? applyArgs[0] : parts[1];
        if (sourceArgIsRouteKey(routeKeyArg || '', aliases)) return true;
      }
      const searchAssignment = suffixText.match(new RegExp(`^\\s*(?:\\))*${searchAccess}\\s*(?:\\+=|=(?!=|>))`, 'u'));
      if (searchAssignment) {
        const expression = extractAssignmentExpression(scopedText, callEnd + searchAssignment[0].length);
        if (expressionBuildsRouteQuery(expression, aliases, directSearchQueryAliases, directSearchConstructorAliases)) return true;
      }
      return false;
    };
    const directCallRe = new RegExp(`(?:^|[^\\w$.])${callStartPattern}`, 'gu');
    let directCall = directCallRe.exec(scopedText);
    while (directCall) {
      const parsed = extractCallArgs(scopedText, directCallRe.lastIndex);
      if (!hasMemberAccessPrefix(scopedText, directCall.index) && scanFactoryCallSuffix(directCall.index, parsed.end)) {
        return true;
      }
      if (parsed.end > directCallRe.lastIndex) directCallRe.lastIndex = parsed.end;
      directCall = directCallRe.exec(scopedText);
    }
  }
  return false;
}

function collectRouteUrlVariables(
  source,
  externalAliases = collectExternalUrlAliases(source),
  staticRelativeAliases = collectStaticRelativeUrlAliases(source),
  routeUrlFactoryAliases = null
) {
  const text = String(source || '');
  const out = new Set();
  const fullScope = { start: 0, end: text.length };
  const baseFactories = routeUrlFactoryAliases || collectRouteUrlFactoryAliases(text, externalAliases, staticRelativeAliases);
  const factories = expandRouteUrlFactoryAliases(
    text,
    baseFactories,
    { isReferenceShadowed: (factory, index) => referenceIsShadowedInScope(text, factory, fullScope, index) }
  );
  const baseFactorySet = new Set(baseFactories);
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu'),
    new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE})\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      const parsed = extractCallArgs(text, re.lastIndex);
      if (!urlConstructorArgsAreExternal(parsed.args, externalAliases, staticRelativeAliases)) out.add(normalizeStaticMemberExpression(match[1]));
      if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
      match = re.exec(text);
    }
  });
  if (factories.size) {
    for (const factory of factories) {
      const factoryCallPattern = functionInvocationStartPattern(expressionReferencePatternForSource(factory, text));
      [
        new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${factoryCallPattern}`, 'gu'),
        new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:await\\s+)?${factoryCallPattern}`, 'gu'),
        new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE})\\s*=\\s*(?:await\\s+)?${factoryCallPattern}`, 'gu')
      ].forEach((re) => {
        let match = re.exec(text);
        while (match) {
          const parsed = extractCallArgs(text, re.lastIndex);
          if (!referenceIsShadowedInScope(text, factory, fullScope, match.index)) {
            out.add(normalizeStaticMemberExpression(match[1]));
          }
          if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
          match = re.exec(text);
        }
      });
    }
  }
  return out;
}

function collectLocationAliases(source) {
  const text = String(source || '');
  const out = new Set();
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:window\\s*\\.\\s*)?location\\b`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:window\\s*\\.\\s*)?location\\b`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      out.add(match[1]);
      match = re.exec(text);
    }
  });
  const destructureRe = /\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*window\b/gu;
  let destructure = destructureRe.exec(text);
  while (destructure) {
    const body = destructure[1] || '';
    const aliasRe = /(?:^|,)\s*location\s*:\s*([A-Za-z_$][\w$]*)/gu;
    let alias = aliasRe.exec(body);
    while (alias) {
      out.add(alias[1]);
      alias = aliasRe.exec(body);
    }
    destructure = destructureRe.exec(text);
  }
  return out;
}

function locationSearchWritePattern(locationAliases = new Set()) {
  const aliasPatterns = Array.from(locationAliases || []).map(expressionReferencePattern);
  const ownerPattern = aliasPatterns.length
    ? `(?:\\b(?:window\\s*\\.\\s*)?location|${aliasPatterns.join('|')})`
    : '\\b(?:window\\s*\\.\\s*)?location';
  return searchWritePatternForOwnerPattern(ownerPattern);
}

function searchWritePatternForOwnerPattern(ownerPattern, propertyAliases = new Set()) {
  const searchProperty = propertyAccessorPattern('search', propertyAliases);
  return new RegExp(`${ownerPattern}\\s*${searchProperty}\\s*(?:\\+=|=(?!=|>))`, 'gu');
}

function searchWritePatternForOwner(owner, source = '') {
  return searchWritePatternForOwnerPattern(
    expressionReferencePattern(owner),
    collectStaticStringAliases(source, 'search')
  );
}

function containsForbiddenRouteUrlMutation(source, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases = null) {
  const text = String(source || '');
  const vars = collectRouteUrlVariables(text, externalAliases, staticRelativeAliases, routeUrlFactoryAliases);
  for (const name of vars) {
    if (containsRouteKeyWriteForOwner(text, name, aliases, 'searchParams')) return true;
    if (containsForbiddenSearchAssignment(text, searchWritePatternForOwner(name, text), aliases)) return true;
    const paramsAliases = collectSearchParamsAliasesForRouteUrl(text, name);
    for (const paramsAlias of paramsAliases) {
      if (containsRouteKeyWriteForOwner(text, paramsAlias, aliases)) return true;
    }
  }
  return false;
}

function containsForbiddenInlineRouteUrlCallbackMutation(source, aliases, externalAliases, staticRelativeAliases) {
  const text = String(source || '');
  const scan = maskNonCodeForRouteGuard(text);
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const callbackMutatesRouteUrl = (body, owner) => {
    if (containsRouteKeyWriteForOwner(body, owner, aliases, 'searchParams')) return true;
    if (containsForbiddenSearchAssignment(body, searchWritePatternForOwner(owner, body), aliases)) return true;
    const paramsAliases = collectSearchParamsAliasesForRouteUrl(body, owner);
    for (const paramsAlias of paramsAliases) {
      if (containsRouteKeyWriteForOwner(body, paramsAlias, aliases)) return true;
    }
    return false;
  };
  const containingBlockSpan = (index) => {
    const stack = [];
    let quote = '';
    let escaped = false;
    for (let i = 0; i < Math.max(0, index); i += 1) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') stack.push(i);
      else if (ch === '}' && stack.length) stack.pop();
    }
    const open = stack.length ? stack[stack.length - 1] : -1;
    if (open < 0) return { start: 0, end: text.length };
    const span = extractBlockSpan(text, open);
    return { start: open + 1, end: Math.max(open + 1, span.end - 1) };
  };
  const argsAreRelative = (argsStart) => {
    const parsed = extractCallArgs(text, argsStart);
    return {
      relative: !urlConstructorArgsAreExternal(parsed.args, externalAliases, staticRelativeAliases),
      end: parsed.end
    };
  };
  const expressionIsRelativeNewUrl = (expression) => {
    let value = String(expression || '').trim();
    while (value.startsWith('(')) {
      const parsed = extractCallArgs(value, 1);
      if (value.slice(parsed.end).trim()) break;
      value = parsed.args.trim();
    }
    const match = value.match(new RegExp(`^new\\s+(?:${constructorPattern})\\s*\\(`, 'u'));
    if (!match) return false;
    const parsed = extractCallArgs(value, match[0].length);
    return !urlConstructorArgsAreExternal(parsed.args, externalAliases, staticRelativeAliases);
  };
  const callbackOwnerIndexes = (paramsText, body) => {
    const out = [];
    splitTopLevelArgs(paramsText).forEach((param, ownerIndex) => {
      const simple = String(param || '').trim().match(/^([A-Za-z_$][\w$]*)$/u);
      if (simple && callbackMutatesRouteUrl(body, simple[1])) out.push(ownerIndex);
    });
    return out;
  };
  const callbackInvocationArgs = (method, argsText) => {
    const parts = splitTopLevelArgs(argsText);
    if (method === 'direct') return parts;
    if (method === 'call') return parts.slice(1);
    const arrayArg = String(parts[1] || '').trim();
    if (!arrayArg.startsWith('[')) return [];
    const close = arrayArg.lastIndexOf(']');
    return splitTopLevelArgs(close >= 0 ? arrayArg.slice(1, close) : arrayArg.slice(1));
  };
  const inlineCallbackInvocationIsForbidden = (paramsText, body, method, argsStart) => {
    const parsed = extractCallArgs(text, argsStart);
    const actualArgs = callbackInvocationArgs(method, parsed.args);
    return {
      end: parsed.end,
      forbidden: callbackOwnerIndexes(paramsText, body).some((ownerIndex) => expressionIsRelativeNewUrl(actualArgs[ownerIndex] || ''))
    };
  };
  const callIsShadowedInNestedScope = (name, scope, scopedCallIndex) => {
    const globalCallIndex = scope.start + scopedCallIndex;
    const rootName = String(name || '').split(/\s*\.\s*/u).filter(Boolean)[0] || '';
    if (!rootName) return false;
    const before = text.slice(scope.start, globalCallIndex);
    const scopeStack = blockStackAt(text, scope.start);
    const callStack = blockStackAt(text, globalCallIndex);
    const stackIsCallAncestor = (stack) => (
      stack.length > scopeStack.length
      && stack.length <= callStack.length
      && stack.every((open, index) => callStack[index] === open)
    );
    const shadowRe = new RegExp(`\\b(?:const|let|var|function)\\s+${escapeRe(rootName)}\\b`, 'gu');
    let shadow = shadowRe.exec(before);
    while (shadow) {
      if (stackIsCallAncestor(blockStackAt(text, scope.start + shadow.index))) return true;
      shadow = shadowRe.exec(before);
    }
    return false;
  };
  const callbackCallSuffix = new RegExp(`^\\s*\\)\\s*(?:(?:\\?\\.\\s*)?\\(|(?:\\?\\.\\s*)?\\.\\s*(call|apply)\\s*(?:\\?\\.\\s*)?\\(|\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]\\s*(?:\\?\\.\\s*)?\\(|\\[\\s*["'\`](call|apply)["'\`]\\s*\\]\\s*(?:\\?\\.\\s*)?\\()`, 'u');
  const re = new RegExp(`\\(\\s*(?:async\\s*)?\\(?\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)?\\s*=>\\s*\\(([\\s\\S]*?)\\)\\s*\\)\\s*\\(\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  let match = re.exec(text);
  while (match) {
    const parsed = argsAreRelative(re.lastIndex);
    if (parsed.relative && callbackMutatesRouteUrl(match[2] || '', match[1])) {
      return true;
    }
    if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
    match = re.exec(text);
  }
  const callRe = new RegExp(`\\(\\s*(?:async\\s*)?\\(?\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)?\\s*=>\\s*\\(([\\s\\S]*?)\\)\\s*\\)\\s*\\.\\s*call\\s*\\(\\s*[\\s\\S]*?,\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  match = callRe.exec(text);
  while (match) {
    const parsed = argsAreRelative(callRe.lastIndex);
    if (parsed.relative && callbackMutatesRouteUrl(match[2] || '', match[1])) return true;
    if (parsed.end > callRe.lastIndex) callRe.lastIndex = parsed.end;
    match = callRe.exec(text);
  }
  const applyRe = new RegExp(`\\(\\s*(?:async\\s*)?\\(?\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)?\\s*=>\\s*\\(([\\s\\S]*?)\\)\\s*\\)\\s*\\.\\s*apply\\s*\\(\\s*[\\s\\S]*?,\\s*\\[\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  match = applyRe.exec(text);
  while (match) {
    const parsed = argsAreRelative(applyRe.lastIndex);
    if (parsed.relative && callbackMutatesRouteUrl(match[2] || '', match[1])) return true;
    if (parsed.end > applyRe.lastIndex) applyRe.lastIndex = parsed.end;
    match = applyRe.exec(text);
  }
  const expressionMethodRe = /\(\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\(/gu;
  match = expressionMethodRe.exec(text);
  while (match) {
    const bodyParsed = extractCallArgs(text, expressionMethodRe.lastIndex);
    const suffix = text.slice(bodyParsed.end).match(callbackCallSuffix);
    if (suffix) {
      const argsStart = bodyParsed.end + suffix[0].length;
      const parsed = inlineCallbackInvocationIsForbidden(match[1], bodyParsed.args, suffix[1] || suffix[2] || suffix[3] || 'direct', argsStart);
      if (parsed.forbidden) return true;
      if (parsed.end > expressionMethodRe.lastIndex) expressionMethodRe.lastIndex = parsed.end;
    } else if (bodyParsed.end > expressionMethodRe.lastIndex) {
      expressionMethodRe.lastIndex = bodyParsed.end;
    }
    match = expressionMethodRe.exec(text);
  }
  const blockArrowRe = new RegExp(`\\(\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*\\{`, 'gu');
  match = blockArrowRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, blockArrowRe.lastIndex - 1);
    const suffix = text.slice(span.end).match(callbackCallSuffix);
    if (suffix) {
      const parsed = inlineCallbackInvocationIsForbidden(match[1] || match[2], span.body, suffix[1] || suffix[2] || suffix[3] || 'direct', span.end + suffix[0].length);
      if (parsed.forbidden) return true;
      if (parsed.end > blockArrowRe.lastIndex) blockArrowRe.lastIndex = parsed.end;
    }
    match = blockArrowRe.exec(text);
  }
  const functionRe = new RegExp(`\\(\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = functionRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, functionRe.lastIndex - 1);
    const suffix = text.slice(span.end).match(callbackCallSuffix);
    if (suffix) {
      const parsed = inlineCallbackInvocationIsForbidden(match[1], span.body, suffix[1] || suffix[2] || suffix[3] || 'direct', span.end + suffix[0].length);
      if (parsed.forbidden) return true;
      if (parsed.end > functionRe.lastIndex) functionRe.lastIndex = parsed.end;
    }
    match = functionRe.exec(text);
  }
  const mutators = [];
  const mutatorKeys = new Set();
  const addMutatorAlias = (name, scope, ownerIndex = 0) => {
    const normalizedScope = scope || { start: 0, end: text.length };
    const key = `${normalizedScope.start}:${normalizedScope.end}:${ownerIndex}:${name}`;
    if (mutatorKeys.has(key)) return;
    mutatorKeys.add(key);
    mutators.push({ name, scope: normalizedScope, ownerIndex });
  };
  const addMutator = (name, owner, body, index, scope = null, ownerIndex = 0) => {
    if (!callbackMutatesRouteUrl(body, owner)) return;
    addMutatorAlias(name, scope || containingBlockSpan(index), ownerIndex);
  };
  const addMutatorsForParams = (name, paramsText, body, index, scope = null) => {
    splitTopLevelArgs(paramsText).forEach((param, ownerIndex) => {
      const simple = String(param || '').trim().match(/^([A-Za-z_$][\w$]*)$/u);
      if (simple) addMutator(name, simple[1], body, index, scope, ownerIndex);
    });
  };
  const mutatorExpressionArrowRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(?\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)?\\s*=>\\s*`, 'gu');
  match = mutatorExpressionArrowRe.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, mutatorExpressionArrowRe.lastIndex);
    addMutator(match[1], match[2], expression, match.index);
    mutatorExpressionArrowRe.lastIndex += expression.length;
    match = mutatorExpressionArrowRe.exec(text);
  }
  const mutatorArrowRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(?\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)?\\s*=>\\s*\\{`, 'gu');
  match = mutatorArrowRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, mutatorArrowRe.lastIndex - 1);
    addMutator(match[1], match[2], span.body, match.index);
    match = mutatorArrowRe.exec(text);
  }
  const mutatorFunctionExpressionRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)\\s*\\{`, 'gu');
  match = mutatorFunctionExpressionRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, mutatorFunctionExpressionRe.lastIndex - 1);
    addMutator(match[1], match[2], span.body, match.index);
    match = mutatorFunctionExpressionRe.exec(text);
  }
  const mutatorFunctionRe = new RegExp(`\\bfunction\\s+(${IDENTIFIER_PATTERN.source})\\s*\\(\\s*(${IDENTIFIER_PATTERN.source})\\s*\\)\\s*\\{`, 'gu');
  match = mutatorFunctionRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, mutatorFunctionRe.lastIndex - 1);
    addMutator(match[1], match[2], span.body, match.index);
    match = mutatorFunctionRe.exec(text);
  }
  const mutatorParenthesizedArrowRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*`, 'gu');
  match = mutatorParenthesizedArrowRe.exec(text);
  while (match) {
    if (text[mutatorParenthesizedArrowRe.lastIndex] === '{') {
      const span = extractBlockSpan(text, mutatorParenthesizedArrowRe.lastIndex);
      addMutatorsForParams(match[1], match[2], span.body, match.index);
    } else {
      const expression = extractAssignmentExpression(text, mutatorParenthesizedArrowRe.lastIndex);
      addMutatorsForParams(match[1], match[2], expression, match.index);
      mutatorParenthesizedArrowRe.lastIndex += expression.length;
    }
    match = mutatorParenthesizedArrowRe.exec(text);
  }
  const mutatorFunctionExpressionParamsRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = mutatorFunctionExpressionParamsRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, mutatorFunctionExpressionParamsRe.lastIndex - 1);
    addMutatorsForParams(match[1], match[2], span.body, match.index);
    match = mutatorFunctionExpressionParamsRe.exec(text);
  }
  const mutatorFunctionParamsRe = new RegExp(`\\bfunction\\s+(${IDENTIFIER_PATTERN.source})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
  match = mutatorFunctionParamsRe.exec(text);
  while (match) {
    const span = extractBlockSpan(text, mutatorFunctionParamsRe.lastIndex - 1);
    addMutatorsForParams(match[1], match[2], span.body, match.index);
    match = mutatorFunctionParamsRe.exec(text);
  }
  const scanObjectMutatorMembers = (baseName, objectBody, objectBodyStart, objectIndex, objectScope) => {
    const objectBodyScan = maskNonCodeForRouteGuard(objectBody);
    const memberIsTopLevel = (index) => braceDepthAt(objectBody, index) === 0;
    const memberIsScannable = (index) => (
      (index === 0 || objectBodyScan[index] === ',')
      && memberIsTopLevel(index)
    );
    const methodRe = new RegExp(`(?:^|[,\\{])\\s*(?:async\\s+)?(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let method = methodRe.exec(objectBody);
    while (method) {
      if (!memberIsScannable(method.index)) {
        method = methodRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(method[1]);
      const methodOpenBrace = objectBodyStart + methodRe.lastIndex - 1;
      const methodSpan = extractBlockSpan(text, methodOpenBrace);
      if (property) addMutatorsForParams(`${baseName}.${property}`, method[2], methodSpan.body, objectIndex, objectScope);
      methodRe.lastIndex = Math.max(methodRe.lastIndex, methodSpan.end - objectBodyStart);
      method = methodRe.exec(objectBody);
    }
    const propertyFunctionRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)\\s*\\{`, 'gu');
    let propertyFunction = propertyFunctionRe.exec(objectBody);
    while (propertyFunction) {
      if (!memberIsScannable(propertyFunction.index)) {
        propertyFunction = propertyFunctionRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyFunction[1]);
      const functionOpenBrace = objectBodyStart + propertyFunctionRe.lastIndex - 1;
      const functionSpan = extractBlockSpan(text, functionOpenBrace);
      if (property) addMutatorsForParams(`${baseName}.${property}`, propertyFunction[2], functionSpan.body, objectIndex, objectScope);
      propertyFunctionRe.lastIndex = Math.max(propertyFunctionRe.lastIndex, functionSpan.end - objectBodyStart);
      propertyFunction = propertyFunctionRe.exec(objectBody);
    }
    const propertyArrowRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|(${IDENTIFIER_PATTERN.source}))\\s*=>\\s*`, 'gu');
    let propertyArrow = propertyArrowRe.exec(objectBody);
    while (propertyArrow) {
      if (!memberIsScannable(propertyArrow.index)) {
        propertyArrow = propertyArrowRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyArrow[1]);
      const params = propertyArrow[2] || propertyArrow[3] || '';
      const valueStart = objectBodyStart + propertyArrowRe.lastIndex;
      if (text[valueStart] === '{') {
        const arrowSpan = extractBlockSpan(text, valueStart);
        if (property) addMutatorsForParams(`${baseName}.${property}`, params, arrowSpan.body, objectIndex, objectScope);
        propertyArrowRe.lastIndex = Math.max(propertyArrowRe.lastIndex, arrowSpan.end - objectBodyStart);
      } else {
        const expression = extractAssignmentExpression(text, valueStart);
        if (property) addMutatorsForParams(`${baseName}.${property}`, params, expression, objectIndex, objectScope);
        propertyArrowRe.lastIndex += expression.length;
      }
      propertyArrow = propertyArrowRe.exec(objectBody);
    }
    const propertyObjectRe = new RegExp(`(?:^|[,\\{])\\s*(${STATIC_OBJECT_PROPERTY_KEY_PATTERN_SOURCE})\\s*:\\s*\\{`, 'gu');
    let propertyObject = propertyObjectRe.exec(objectBody);
    while (propertyObject) {
      if (!memberIsScannable(propertyObject.index)) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const property = normalizeStaticObjectPropertyKey(propertyObject[1]);
      const nestedOpenBrace = text.indexOf('{', objectBodyStart + propertyObject.index);
      if (!property || nestedOpenBrace < 0) {
        propertyObject = propertyObjectRe.exec(objectBody);
        continue;
      }
      const nestedSpan = extractBlockSpan(text, nestedOpenBrace);
      scanObjectMutatorMembers(
        `${baseName}.${property}`,
        nestedSpan.body,
        nestedOpenBrace + 1,
        objectIndex,
        objectScope
      );
      propertyObjectRe.lastIndex = Math.max(propertyObjectRe.lastIndex, nestedSpan.end - objectBodyStart);
      propertyObject = propertyObjectRe.exec(objectBody);
    }
  };
  const objectLiteralRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*\\{`, 'gu');
  match = objectLiteralRe.exec(scan);
  while (match) {
    const objectName = match[1];
    const objectScope = containingBlockSpan(match.index);
    const objectSpan = extractBlockSpan(text, objectLiteralRe.lastIndex - 1);
    const objectBodyStart = objectLiteralRe.lastIndex;
    scanObjectMutatorMembers(objectName, objectSpan.body, objectBodyStart, match.index, objectScope);
    if (objectSpan.end > objectLiteralRe.lastIndex) objectLiteralRe.lastIndex = objectSpan.end;
    match = objectLiteralRe.exec(scan);
  }
  for (let i = 0; i < mutators.length; i += 1) {
    const { name, scope, ownerIndex } = mutators[i];
    const scopedText = text.slice(scope.start, scope.end);
    const scopedScan = maskNonCodeForRouteGuard(scopedText);
    const captureStartsInCode = (match, capture) => {
      const offset = match[0].indexOf(capture);
      const index = offset >= 0 ? match.index + offset : match.index;
      return /\S/u.test(scopedScan[index] || '');
    };
    const objectAliasRe = new RegExp(`\\b(const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*\\{`, 'gu');
    let objectAlias = objectAliasRe.exec(scopedText);
    while (objectAlias) {
      const kind = objectAlias[1];
      const objectName = objectAlias[2];
      if (!captureStartsInCode(objectAlias, kind)) {
        objectAlias = objectAliasRe.exec(scopedText);
        continue;
      }
      const objectSpan = extractBlockSpan(scopedText, objectAliasRe.lastIndex - 1);
      if (kind === 'const' || !bindingIsReassigned(scopedText, objectName, objectAliasRe.lastIndex)) {
        for (const part of splitTopLevelArgs(objectSpan.body)) {
          const property = objectPropertyNameFromPart(part);
          const value = objectPropertyValueFromPart(part);
          if (property
            && value
            && expressionReferencesRouteFactory(value, new Set([name]))
            && !callIsShadowedInNestedScope(name, scope, objectAlias.index)) {
            addMutatorAlias(`${objectName}.${property}`, containingBlockSpan(scope.start + objectAlias.index), ownerIndex);
          }
        }
      }
      if (objectSpan.end > objectAliasRe.lastIndex) objectAliasRe.lastIndex = objectSpan.end;
      objectAlias = objectAliasRe.exec(scopedText);
    }
    const memberAliasRe = new RegExp(`(?:^|[^\\w$])(${MEMBER_EXPRESSION_WITH_STATIC_KEYS_PATTERN_SOURCE})\\s*=\\s*(?!=|>)(?:\\(\\s*)*${expressionReferencePatternForSource(name, scopedText)}\\s*(?:\\))*`, 'gu');
    let memberAlias = memberAliasRe.exec(scopedText);
    while (memberAlias) {
      if (captureStartsInCode(memberAlias, memberAlias[1]) && !callIsShadowedInNestedScope(name, scope, memberAlias.index)) {
        addMutatorAlias(normalizeStaticMemberExpression(memberAlias[1]), scope, ownerIndex);
      }
      memberAlias = memberAliasRe.exec(scopedText);
    }
    const parts = String(name || '').split('.');
    if (parts.length > 1 && parts.every((part) => new RegExp(`^(?:this|${IDENTIFIER_PATTERN.source})$`, 'u').test(part))) {
      const owner = parts.slice(0, -1).join('.');
      const property = parts[parts.length - 1];
      const destructureRe = new RegExp(`\\b(const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${expressionReferencePattern(owner)}\\b`, 'gu');
      let destructure = destructureRe.exec(scopedText);
      while (destructure) {
        const kind = destructure[1];
        if (captureStartsInCode(destructure, kind)) {
          for (const aliasName of collectDestructuredStaticPropertyAliases(destructure[2] || '', property)) {
            if (!callIsShadowedInNestedScope(name, scope, destructure.index)
              && (kind === 'const' || !bindingIsReassigned(scopedText, aliasName, destructureRe.lastIndex))) {
              addMutatorAlias(aliasName, scope, ownerIndex);
            }
          }
        }
        destructure = destructureRe.exec(scopedText);
      }
    }
    const bindRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*${expressionReferencePatternForSource(name, scopedText)}${propertyAccessorPattern('bind')}\\s*(?:\\?\\.\\s*)?\\(`, 'gu');
    let bind = bindRe.exec(scopedText);
    while (bind) {
      const parsed = extractCallArgs(scopedText, bindRe.lastIndex);
      const boundArgs = splitTopLevelArgs(parsed.args).slice(1);
      if (captureStartsInCode(bind, bind[1])
        && expressionIsRelativeNewUrl(boundArgs[ownerIndex] || '')
        && !callIsShadowedInNestedScope(name, scope, bind.index)) return true;
      const remainingOwnerIndex = ownerIndex - boundArgs.length;
      if (captureStartsInCode(bind, bind[1]) && remainingOwnerIndex >= 0) addMutatorAlias(bind[1], scope, remainingOwnerIndex);
      if (parsed.end > bindRe.lastIndex) bindRe.lastIndex = parsed.end;
      bind = bindRe.exec(scopedText);
    }
  }
  for (const { name, scope, ownerIndex } of mutators) {
    const scopedText = text.slice(scope.start, scope.end);
    const calleePattern = expressionReferencePatternForSource(name, scopedText);
    const directCallRe = new RegExp(`(^|[^\\w$.])${calleePattern}\\s*(?:\\?\\.\\s*)?\\(`, 'gu');
    match = directCallRe.exec(scopedText);
    while (match) {
      const parsed = extractCallArgs(scopedText, directCallRe.lastIndex);
      const parts = splitTopLevelArgs(parsed.args);
      const relative = expressionIsRelativeNewUrl(parts[ownerIndex] || '');
      const shadowed = callIsShadowedInNestedScope(name, scope, match.index);
      if (relative && !hasMemberAccessPrefix(scopedText, match.index) && !shadowed) return true;
      if (parsed.end > directCallRe.lastIndex) directCallRe.lastIndex = parsed.end;
      match = directCallRe.exec(scopedText);
    }
    const methodCallRe = new RegExp(`${calleePattern}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`, 'gu');
    match = methodCallRe.exec(scopedText);
    while (match) {
      const method = match[1] || match[2] || match[3];
      const parsed = extractCallArgs(scopedText, methodCallRe.lastIndex);
      const parts = splitTopLevelArgs(parsed.args);
      const applyArgs = method === 'apply' ? splitTopLevelArgs((parts[1] || '').trim().replace(/^\[\s*|\s*\]$/gu, '')) : [];
      const relative = method === 'apply'
        ? expressionIsRelativeNewUrl(applyArgs[ownerIndex] || '')
        : expressionIsRelativeNewUrl(parts[ownerIndex + 1] || '');
      if (relative
        && !hasMemberAccessPrefix(scopedText, match.index)
        && !callIsShadowedInNestedScope(name, scope, match.index)) return true;
      if (parsed.end > methodCallRe.lastIndex) methodCallRe.lastIndex = parsed.end;
      match = methodCallRe.exec(scopedText);
    }
  }
  return false;
}

function collectSearchParamsAliasesForRouteUrl(source, owner) {
  const text = String(source || '');
  const out = new Set();
  const ownerPattern = expressionReferencePattern(owner);
  const searchParamsAccess = propertyAccessorPattern('searchParams', collectStaticStringAliases(text, 'searchParams'));
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*${ownerPattern}${searchParamsAccess}(?:\\s*\\))*`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*${ownerPattern}${searchParamsAccess}(?:\\s*\\))*`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      out.add(match[1]);
      match = re.exec(text);
    }
  });
  const destructureRe = new RegExp(`\\b(?:const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${ownerPattern}\\b`, 'gu');
  let destructure = destructureRe.exec(text);
  while (destructure) {
    const body = destructure[1] || '';
    for (const alias of collectDestructuredStaticPropertyAliases(body, 'searchParams')) {
      out.add(alias);
    }
    destructure = destructureRe.exec(text);
  }
  return out;
}

function collectInlineUrlSearchParamsAliases(source) {
  const text = String(source || '');
  const out = new Set();
  const searchParamsAccess = propertyAccessorPattern('searchParams', collectStaticStringAliases(text, 'searchParams'));
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  [
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu'),
    new RegExp(`(?:^|[^\\w$.])(${IDENTIFIER_PATTERN.source})\\s*=\\s*(?:\\(\\s*)*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu')
  ].forEach((re) => {
    let match = re.exec(text);
    while (match) {
      const parsed = extractCallArgs(text, re.lastIndex);
      const suffix = text.slice(parsed.end).match(new RegExp(`^\\s*(?:\\))*${searchParamsAccess}`, 'u'));
      if (suffix) out.add(match[1]);
      if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
      match = re.exec(text);
    }
  });
  const destructureRe = new RegExp(`\\b(?:const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*new\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  let destructure = destructureRe.exec(text);
  while (destructure) {
    const parsed = extractCallArgs(text, destructureRe.lastIndex);
    const body = destructure[1] || '';
    for (const alias of collectDestructuredStaticPropertyAliases(body, 'searchParams')) {
      out.add(alias);
    }
    if (parsed.end > destructureRe.lastIndex) destructureRe.lastIndex = parsed.end;
    destructure = destructureRe.exec(text);
  }
  return out;
}

function containsForbiddenInlineRouteUrlSearchParamsMutation(
  source,
  aliases,
  externalAliases,
  staticRelativeAliases,
  routeUrlFactoryAliases = null
) {
  const text = String(source || '');
  const searchParamsAccess = propertyAccessorPattern('searchParams', collectStaticStringAliases(text, 'searchParams'));
  const searchAccess = propertyAccessorPattern('search', collectStaticStringAliases(text, 'search'));
  const mutator = `(?:${propertyAccessorPattern('set')}|${propertyAccessorPattern('append')}|${propertyAccessorPattern('delete')})`;
  const parenthesizedRouteKey = `(?:\\(\\s*)*(?:${IDENTIFIER_PATTERN.source}|${ROUTE_KEY_LITERAL_EXPRESSION_PATTERN_SOURCE})(?:\\s*\\))*`;
  const constructorAliases = collectUrlSearchParamsConstructorAliases(text);
  const queryAliases = collectRouteQueryAliases(text, aliases, constructorAliases);
  const checkRouteUrlCallSuffix = (callEnd) => {
    const suffixRe = new RegExp(`^\\s*(?:\\))*${searchParamsAccess}${mutator}\\s*(?:\\?\\.\\s*)?\\(\\s*(${parenthesizedRouteKey}|[^,\\)]+)\\s*(?:,|\\))`, 'u');
    const suffix = text.slice(callEnd).match(suffixRe);
    if (suffix && sourceArgIsRouteKey(suffix[1], aliases)) return true;
    const dispatchRe = new RegExp(`^\\s*(?:\\))*${searchParamsAccess}${mutator}(?:\\s*(?:\\?\\.\\s*|\\.\\s*)(call|apply)|\\s*\\?\\.\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\]|\\s*\\[\\s*["'\`](call|apply)["'\`]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`, 'u');
    const dispatch = text.slice(callEnd).match(dispatchRe);
    if (dispatch) {
      const method = dispatch[1] || dispatch[2] || dispatch[3];
      const parsed = extractCallArgs(text, callEnd + dispatch[0].length);
      const parts = splitTopLevelArgs(parsed.args);
      const applyArgs = method === 'apply' ? splitTopLevelArgs((parts[1] || '').trim().replace(/^\[\s*|\s*\]$/gu, '')) : [];
      const routeKeyArg = method === 'apply' ? applyArgs[0] : parts[1];
      if (sourceArgIsRouteKey(routeKeyArg || '', aliases)) return true;
    }
    const searchAssignmentRe = new RegExp(`^\\s*(?:\\))*${searchAccess}\\s*(?:\\+=|=(?!=|>))`, 'u');
    const searchAssignment = text.slice(callEnd).match(searchAssignmentRe);
    if (searchAssignment) {
      const expression = extractAssignmentExpression(text, callEnd + searchAssignment[0].length);
      if (expressionBuildsRouteQuery(expression, aliases, queryAliases, constructorAliases)) return true;
    }
    return false;
  };
  const constructorPattern = urlConstructorPattern(collectUrlConstructorAliases(text));
  const re = new RegExp(`\\bnew\\s+(?:${constructorPattern})\\s*\\(`, 'gu');
  let match = re.exec(text);
  while (match) {
    const parsed = extractCallArgs(text, re.lastIndex);
    if (!urlConstructorArgsAreExternal(parsed.args, externalAliases, staticRelativeAliases)) {
      if (checkRouteUrlCallSuffix(parsed.end)) return true;
    }
    if (parsed.end > re.lastIndex) re.lastIndex = parsed.end;
    match = re.exec(text);
  }
  const fullScope = { start: 0, end: text.length };
  const baseFactories = routeUrlFactoryAliases || collectRouteUrlFactoryAliases(text, externalAliases, staticRelativeAliases);
  const factories = expandRouteUrlFactoryAliases(
    text,
    baseFactories,
    { isReferenceShadowed: (factory, index) => referenceIsShadowedInScope(text, factory, fullScope, index) }
  );
  const baseFactorySet = new Set(baseFactories);
  if (factories.size) {
    for (const factory of factories) {
      const callableNamePattern = `(?:\\(\\s*)*${expressionReferencePatternForSource(factory, text)}\\s*(?:\\))*`;
      const factoryCallRe = new RegExp(`(?:^|[^\\w$.])${functionInvocationStartPattern(callableNamePattern)}`, 'gu');
      match = factoryCallRe.exec(text);
      while (match) {
        const parsed = extractCallArgs(text, factoryCallRe.lastIndex);
        if (!hasMemberAccessPrefix(text, match.index)
          && !(baseFactorySet.has(factory) && referenceIsShadowedInScope(text, factory, fullScope, match.index))
          && checkRouteUrlCallSuffix(parsed.end)) return true;
        if (parsed.end > factoryCallRe.lastIndex) factoryCallRe.lastIndex = parsed.end;
        match = factoryCallRe.exec(text);
      }
    }
  }
  return false;
}

function containsForbiddenSearchAssignment(source, re, aliases = new Set()) {
  const text = String(source || '');
  const constructorAliases = collectUrlSearchParamsConstructorAliases(text);
  const queryAliases = collectRouteQueryAliases(text, aliases, constructorAliases);
  let match = re.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, re.lastIndex);
    if (expressionBuildsRouteQuery(expression, aliases, queryAliases, constructorAliases)) return true;
    match = re.exec(text);
  }
  return false;
}

function containsForbiddenLocationSearchAssignment(source, aliases = new Set()) {
  return containsForbiddenSearchAssignment(
    source,
    locationSearchWritePattern(collectLocationAliases(source)),
    aliases
  );
}

function containsForbiddenExecutableRouteCode(
  text,
  aliases,
  externalAliases,
  staticRelativeAliases,
  routeUrlFactoryAliases = null
) {
  const inlineSearchParamsAliases = collectInlineUrlSearchParamsAliases(text);
  const constructorAliases = collectUrlSearchParamsConstructorAliases(text);
  const queryAliases = collectRouteQueryAliases(text, aliases, constructorAliases);
  return containsForbiddenRouteLiteral(text, externalAliases)
    || containsForbiddenLocationSearchAssignment(text, aliases)
    || containsRelativeQueryAliasSerialization(text, queryAliases, externalAliases)
    || containsForbiddenUrlSearchParamsInitializer(text, aliases, externalAliases)
    || containsForbiddenInlineUrlSearchParamsInitializer(text, aliases, externalAliases)
    || containsForbiddenSplitRouteQueryLiteral(text, externalAliases, aliases)
    || containsForbiddenRouteKeyAliasConstruction(text, aliases, externalAliases)
    || containsForbiddenUrlSearchParamsVariable(text, aliases, externalAliases)
    || containsForbiddenRouteUrlMutation(text, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
    || containsForbiddenScopedRouteUrlFactoryMutation(text, aliases, externalAliases, staticRelativeAliases)
    || containsForbiddenInlineRouteUrlSearchParamsMutation(text, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
    || containsForbiddenInlineRouteUrlCallbackMutation(text, aliases, externalAliases, staticRelativeAliases)
    || Array.from(inlineSearchParamsAliases).some((name) => (
      containsRouteKeyWriteForOwner(text, name, aliases) && containsRelativeParamsSerialization(text, name, new Set(), externalAliases)
    ));
}

function routeBodyShadowsExternalAlias(params, body, externalAliases, shadowCandidates) {
  if (!shadowCandidates.size || !routeGuardBodyLooksRelevant(body)) return null;
  const bindings = new Set();
  const bodyExternalAliases = collectExternalUrlAliases(topLevelRouteGuardSource(body));
  addBindingNamesFromPattern(bindings, params);
  addLocalDeclarationBindings(bindings, body, { topLevelOnly: true });
  let shadowed = false;
  const scopedExternalAliases = new Set(externalAliases);
  bindings.forEach((name) => {
    if (shadowCandidates.has(name) && !bodyExternalAliases.has(name)) {
      scopedExternalAliases.delete(name);
      shadowed = true;
    }
  });
  return shadowed ? scopedExternalAliases : null;
}

function containsForbiddenShadowedExternalAliasRouteCode(
  source,
  aliases,
  externalAliases,
  shadowCandidates,
  staticRelativeAliases,
  routeUrlFactoryAliases = null
) {
  const text = String(source || '');
  const scanBody = (params, body) => {
    const scopedExternalAliases = routeBodyShadowsExternalAlias(params, body, externalAliases, shadowCandidates);
    const scopedSource = String(params || '').trim()
      ? `function __pressRouteGuard(${params}) {${body}}`
      : body;
    return scopedExternalAliases
      ? containsForbiddenExecutableRouteCode(scopedSource, aliases, scopedExternalAliases, staticRelativeAliases, null)
      : false;
  };
  const catchParamsBeforeBlock = (openBraceIndex) => {
    const before = text.slice(0, openBraceIndex);
    const match = before.match(/\bcatch\s*\(([^)]*)\)\s*$/u);
    return match ? match[1] : '';
  };
  const loopParamsBeforeBlock = (openBraceIndex) => {
    const before = text.slice(0, openBraceIndex);
    const loop = before.match(/\bfor\s*(?:await\s*)?\(([\s\S]*)\)\s*$/u);
    if (!loop) return '';
    const declaration = loop[1].match(/^\s*(?:const|let|var)\s+([\s\S]*?)(?:\s+(?:of|in)\b|[;=]|$)/u);
    return declaration ? declaration[1] : '';
  };
  const functionRe = /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/gu;
  let match = functionRe.exec(text);
  while (match) {
    if (scanBody(match[1], extractBlockText(text, functionRe.lastIndex - 1))) return true;
    match = functionRe.exec(text);
  }
  const arrowRe = /(?:^|[^\w$])(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gu;
  match = arrowRe.exec(text);
  while (match) {
    if (scanBody(match[1], extractBlockText(text, arrowRe.lastIndex - 1))) return true;
    match = arrowRe.exec(text);
  }
  const expressionArrowRe = /(?:^|[^\w$])(?:async\s*)?\(([^)]*)\)\s*=>\s*(?!\s*\{)/gu;
  match = expressionArrowRe.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, expressionArrowRe.lastIndex);
    if (scanBody(match[1], expression)) return true;
    expressionArrowRe.lastIndex += expression.length;
    match = expressionArrowRe.exec(text);
  }
  const singleArrowRe = /(?:^|[^\w$])(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*\{/gu;
  match = singleArrowRe.exec(text);
  while (match) {
    if (scanBody(match[1], extractBlockText(text, singleArrowRe.lastIndex - 1))) return true;
    match = singleArrowRe.exec(text);
  }
  const singleExpressionArrowRe = /(?:^|[^\w$])(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*(?!\s*\{)/gu;
  match = singleExpressionArrowRe.exec(text);
  while (match) {
    const expression = extractAssignmentExpression(text, singleExpressionArrowRe.lastIndex);
    if (scanBody(match[1], expression)) return true;
    singleExpressionArrowRe.lastIndex += expression.length;
    match = singleExpressionArrowRe.exec(text);
  }
  const methodRe = /(?:^|[,{]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*\(([^)]*)\)\s*\{/gu;
  match = methodRe.exec(text);
  while (match) {
    if (scanBody(match[1], extractBlockText(text, methodRe.lastIndex - 1))) return true;
    match = methodRe.exec(text);
  }
  const blockRe = /\{/gu;
  match = blockRe.exec(text);
  while (match) {
    const params = catchParamsBeforeBlock(match.index) || loopParamsBeforeBlock(match.index);
    if (scanBody(params, extractBlockText(text, match.index))) return true;
    match = blockRe.exec(text);
  }
  return false;
}

function scriptTypeAllowsRouteScan(attrs) {
  const match = String(attrs || '').match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>]+))/iu);
  if (!match) return true;
  const type = String(match[1] || match[2] || match[3]).trim().toLowerCase().split(';')[0].trim();
  return !type || [
    'module',
    'text/javascript',
    'application/javascript',
    'text/ecmascript',
    'application/ecmascript',
    'application/x-javascript',
    'text/jscript'
  ].includes(type);
}

function containsForbiddenHtmlInlineRouteCode(source, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases = null) {
  const text = stripHtmlCommentsForRouteGuard(source);
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s>])[^>]*>/giu;
  let match = re.exec(text);
  while (match) {
    if (!scriptTypeAllowsRouteScan(match[1] || '')) {
      match = re.exec(text);
      continue;
    }
    const script = stripCommentsForRouteGuard(match[2] || '');
    if (containsForbiddenExecutableRouteCode(script, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
      || containsForbiddenShadowedExternalAliasRouteCode(script, aliases, externalAliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)) {
      return true;
    }
    match = re.exec(text);
  }
  return false;
}

function containsForbiddenHtmlEventHandlerRouteCode(source, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases = null) {
  const text = stripHtmlCommentsForRouteGuard(source);
  const re = /\bon[a-z][\w:-]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>]+))/giu;
  let match = re.exec(text);
  while (match) {
    const handler = stripCommentsForRouteGuard(decodeHtmlAttributeValue(match[1] || match[2] || match[3] || ''));
    if (containsForbiddenExecutableRouteCode(handler, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
      || containsForbiddenShadowedExternalAliasRouteCode(handler, aliases, externalAliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)) {
      return true;
    }
    match = re.exec(text);
  }
  return false;
}

function containsForbiddenV4RouteConstruction(source, contextSource = source) {
  const rawText = String(source || '');
  const text = stripCommentsForRouteGuard(rawText);
  const context = normalizeRouteGuardContext(contextSource, text);
  const localRouteKeyAliases = collectRouteKeyAliases(text);
  const importedRouteKeyAliases = mergeImportedContextAliases(new Set(), collectRouteKeyAliases, text, context, { shadow: false });
  const aliases = new Set([...localRouteKeyAliases, ...importedRouteKeyAliases]);
  aliases.localAliases = localRouteKeyAliases;
  aliases.importedAliases = importedRouteKeyAliases;
  const localExternalAliases = collectExternalUrlAliases(text);
  const importedExternalAliases = mergeImportedContextAliases(new Set(), collectExternalUrlAliases, text, context, { shadow: false });
  const externalAliases = new Set([...localExternalAliases, ...importedExternalAliases]);
  const staticRelativeAliases = mergeImportedContextAliases(collectStaticRelativeUrlAliases(text), collectStaticRelativeUrlAliases, text, context, { shadow: false });
  const localRouteUrlFactoryAliases = collectRouteUrlFactoryAliases(text, externalAliases, staticRelativeAliases);
  const importedRouteUrlFactoryAliases = mergeImportedContextAliases(new Set(), collectRouteUrlFactoryAliases, text, context, { shadow: false });
  const routeUrlFactoryAliases = new Set([...localRouteUrlFactoryAliases, ...importedRouteUrlFactoryAliases]);
  const hasForbiddenCode = shouldScanExecutableRouteCode(context.path) && (
    containsForbiddenExecutableRouteCode(text, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
    || containsForbiddenShadowedExternalAliasRouteCode(text, aliases, externalAliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
  );
  return hasForbiddenCode
    || (shouldScanHtmlRouteAttributes(context.path, rawText)
      && containsForbiddenHtmlRouteAttribute(stripHtmlCommentsForRouteGuard(rawText)))
    || ((/\.(?:html?|svg)$/iu.test(String(context.path || '')))
      && (containsForbiddenHtmlInlineRouteCode(rawText, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)
        || containsForbiddenHtmlEventHandlerRouteCode(rawText, aliases, externalAliases, staticRelativeAliases, routeUrlFactoryAliases)));
}

function runUnzip(args) {
  const result = spawnSync('unzip', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
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
  return compareSemverParts(a, b);
}

function compareSemverParts(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function nextPatch(parts) {
  return [parts[0], parts[1], parts[2] + 1];
}

function maxSemverParts(left, right) {
  return compareSemverParts(left, right) >= 0 ? left : right;
}

function minSemverParts(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareSemverParts(left, right) <= 0 ? left : right;
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

function semverRangeAllowsBefore(range, boundaryVersion) {
  const boundary = parseSemver(boundaryVersion);
  if (!boundary) return false;
  const clauses = stringValue(range).split('||').map((part) => part.trim()).filter(Boolean);
  return clauses.some((clause) => semverClauseAllowsBefore(clause, boundary));
}

function semverClauseAllowsBefore(clause, boundary) {
  const tokens = stringValue(clause).split(/\s+/u).filter(Boolean);
  if (!tokens.length) return false;
  let lower = [0, 0, 0];
  let upper = boundary;
  for (const token of tokens) {
    const match = token.match(/^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/u);
    if (!match) return false;
    const op = match[1] || '=';
    const version = parseSemver(match[2]);
    if (!version) return false;
    if (op === '>=') lower = maxSemverParts(lower, version);
    else if (op === '>') lower = maxSemverParts(lower, nextPatch(version));
    else if (op === '<') upper = minSemverParts(upper, version);
    else if (op === '<=') upper = minSemverParts(upper, nextPatch(version));
    else {
      lower = maxSemverParts(lower, version);
      upper = minSemverParts(upper, nextPatch(version));
    }
  }
  return compareSemverParts(lower, upper) < 0;
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
