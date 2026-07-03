import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { verifyCatalog } from './verify-catalog.mjs';

test('verifyCatalog accepts a matching local official theme and ZIP asset', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot }) => {
    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, true);
    assert.equal(result.checkedThemes, 1);
    assert.deepEqual(result.failures, []);
  });
});

test('verifyCatalog rejects transition v2 theme releases after cleanup', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.3',
      contractVersion: 2,
      pressRange: '>=3.4.121 <4.0.0'
    });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.version = '3.4.3';
    release.contractVersion = 2;
    release.engines.press = '>=3.4.121 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.3.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.121'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contractVersion must be supported/u);
  });
});

test('verifyCatalog rejects v3 theme releases that allow pre-transition Press versions', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({ pressRange: '>=3.4.0 <4.0.0' });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.engines.press = '>=3.4.0 <4.0.0';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contract v3 engines\.press must not accept Press versions before 3\.4\.127/u);
  });
});

test('verifyCatalog accepts v3 theme releases that require a later Press patch', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({ pressRange: '>=3.4.128 <4.0.0' });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.engines.press = '>=3.4.128 <4.0.0';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.128'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });
});

test('verifyCatalog accepts v4 theme releases for the route-helper transition', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 4,
      pressRange: '>=3.4.130 <4.0.0'
    });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 4;
    release.engines.press = '>=3.4.130 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.6.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });
});

test('verifyCatalog rejects v4 theme releases that allow pre-route-helper Press versions', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 4,
      pressRange: '>=3.4.129 <4.0.0'
    });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 4;
    release.engines.press = '>=3.4.129 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.6.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contract v4 engines\.press must not accept Press versions before 3\.4\.130/u);
  });
});

test('verifyCatalog rejects v4 ZIP packaged source with public route literals', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 4,
      pressRange: '>=3.4.130 <4.0.0'
    });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: theme,
      extraFiles: {
        'modules/layout.js': 'export const href = "?lang=en&tab=posts";\n',
        'modules/views.js': 'export const postHref = "?id=post.md";\n',
        'modules/interactions.js': [
          'export function route(post, tab) {',
          '  const url = new URL(location.href);',
          '  url.searchParams.set("id", "post.md");',
          '  const key = "tab";',
          '  url.searchParams.set(key, tab);',
          '  const params = new URLSearchParams();',
          '  params.set("tab", "posts");',
          '  const objectParams = new URLSearchParams({ id: post.id });',
          '  const arrayParams = new URLSearchParams([["tab", tab]]);',
          '  const routeKey = "id";',
          '  const aliasParams = new URLSearchParams([[routeKey, post.location]]);',
          '  const splitParams = new URLSearchParams("id" + "=" + post.location);',
          '  const multilineParams = new URLSearchParams({',
          '    id: post.id',
          '  });',
          '  const id = post.id;',
          '  const shorthandParams = new URLSearchParams({ id });',
          '  const currentParams = new URLSearchParams();',
          '  currentParams.set("tab", "posts");',
          '  location.search = currentParams.toString();',
          '  const compoundParams = new URLSearchParams();',
          '  compoundParams.set("id", post.id);',
          '  location.search += compoundParams;',
          '  const compoundObjectParams = new URLSearchParams({ id: post.id });',
          '  location.search += compoundObjectParams.toString();',
          '  location.search = new URLSearchParams([["tab", tab]]).toString();',
          '  location.search = "id=" + post.id;',
          '  location.search = `${routeKey}=${post.location}`;',
          '  location.search += routeKey + "=" + post.location;',
          '  let assignedUrl;',
          '  assignedUrl = new URL(location.href);',
          '  assignedUrl.searchParams.set("id", post.id);',
          '  const multilineUrl = new URL(',
          '    location.href',
          '  );',
          '  multilineUrl.searchParams.set("id", post.id);',
          '  const externalBase = "https://api.example.test";',
          '  const currentUrlWithExternalBase = new URL(location.href, externalBase);',
          '  currentUrlWithExternalBase.searchParams.set("id", post.id);',
          '  return ["?" + params, "?" + objectParams, `?${arrayParams}`, "?" + aliasParams, "?" + splitParams, "?" + multilineParams, "?" + shorthandParams, "?" + new URLSearchParams({ id: post.id }), "?" + (new URLSearchParams({ id: post.id })), `?${new URLSearchParams({ id: post.id })}`, "?" + new URLSearchParams(`${routeKey}=${post.location}`), `?${new URLSearchParams(`${routeKey}=${post.location}`)}`, `?${routeKey}=${post.location}`, "?" + routeKey + "=" + post.location, "?" + "id=" + post.id, "?" + "id" + "=" + post.id, url.href, assignedUrl.href, multilineUrl.href, currentUrlWithExternalBase.href];',
          '}'
        ].join('\n')
      }
    });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 4;
    release.engines.press = '>=3.4.130 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.6.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contract v4 ZIP packaged source must use router href helpers/u);
  });
});

test('verifyCatalog rejects isolated v4 route-key alias public route builders', async () => {
  const sources = [
    'export function route(post) { const key = "id"; return `?${new URLSearchParams(`${key}=${post.id}`)}`; }',
    'export function route(post) { const key = "id"; return `?${new URLSearchParams(`${(key)}=${post.id}`)}`; }',
    'export function route(post) { const key = "id"; return "?" + new URLSearchParams((key) + "=" + post.id); }',
    'export function route(post) { return "?" + new URLSearchParams(("id") + "=" + post.id); }',
    'export function route(post) { const key = "id"; return `?${key}=${post.id}`; }',
    'export function route(post) { const key = "id"; return `?${(key)}=${post.id}`; }',
    'export function route(post) { return `?${("id")}=${post.id}`; }',
    'export function route(post) { const key = "id"; return "?" + key + "=" + post.id; }',
    'export function route(post) { const key = "id"; return "?" + (key) + "=" + post.id; }',
    'export function route(post) { return "?" + ("id") + "=" + post.id; }',
    'export function route(post) { return "?" + (("id")) + "=" + post.id; }',
    'export function route() { const key = "id"; const url = new URL(location.href); url.searchParams.set((key), "post.md"); return url.href; }',
    'export function route() { const url = new URL(location.href); url.searchParams.set(("id"), "post.md"); return url.href; }',
    'export function route() { const url = new URL(location.href); url.searchParams.set((("id")), "post.md"); return url.href; }',
    'export function route(post) { let params; params = new URLSearchParams({ id: post.id }); return "?" + params; }',
    'export function route(post) { const url = new URL(location.href); const params = url.searchParams; params.set("id", post.id); return url.href; }',
    'export function route(post) { const key = "tab"; const url = new URL(location.href); let params; params = url.searchParams; params.append(key, "posts"); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const params = (url.searchParams); params.set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const { searchParams } = url; searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const { searchParams: params } = url; params.set("id", post.id); return url.href; }',
    'export function route(post) { const params = new URL(location.href).searchParams; params.set("id", post.id); return "?" + params; }',
    'export function route(post) { const { searchParams } = new URL(location.href); searchParams.set("id", post.id); return `?${searchParams}`; }',
    'export function route(post) { const qs = "id=" + post.id; location.search = qs; }',
    'export function route(post) { const key = "id"; let qs; qs = key + "=" + post.id; location.search = qs.toString(); }',
    'export function route(post) { const loc = location; const key = "id"; const qs = key + "=" + post.id; loc.search = qs; }',
    'export function route(post) { const key = "id"; window.location["search"] = key + "=" + post.id; }',
    'export function route(post) { const loc = location; const key = "id"; loc["search"] = key + "=" + post.id; }',
    'export function route(post) { const { location: loc } = window; const key = "id"; const qs = key + "=" + post.id; loc.search = qs; }',
    'export function route(post) { const loc = window.location; const params = new URLSearchParams({ id: post.id }); loc.search = params; }',
    'export function route(post) { state.params = new URLSearchParams({ id: post.id }); return "?" + state.params; }'
  ];
  for (const source of sources) {
    await assertV4PackagedSourceRejected(source);
  }
  await assertV4PackagedSourceRejected(
    'import { key } from "./config.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const key = "id";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(endpoint, post) { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./internal.js"; export function route(post) { const url = new URL(endpoint, window.location.href); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n',
      'modules/internal.js': 'export const endpoint = location.href;\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { key } from "./config.js"; function unrelated(key) { return key; } export function route(post) { const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const key = "id";\n' }
  );
});

test('verifyCatalog scans v4 JSON and SVG packaged assets for public route literals', async () => {
  await assertV4PackagedSourceRejected('{"href":"?tab=posts"}', 'assets/data.json');
  await assertV4PackagedSourceRejected('<svg><a href="?id=post.md"/></svg>', 'assets/icon.svg');
});

test('verifyCatalog scans oversized v4 packaged source files for public route literals', async () => {
  const padding = 'x'.repeat(2 * 1024 * 1024);
  await assertV4PackagedSourceRejected(`export const padding = "${padding}";\nexport const href = "?id=post.md";`);
});

test('verifyCatalog allows v4 ZIP packaged source with external query strings', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 4,
      pressRange: '>=3.4.130 <4.0.0'
    });
    await writeJson(themePath, theme);
    const fixtureThemeDir = path.dirname(themePath);
    const configSource = 'export const endpoint = "https://api.example.test/product"; export const productPath = "/product"; export const externalRoot = "https://api.example.test";\n';
    const importedSource = 'import { endpoint, productPath, externalRoot } from "./config.js"; export function imported() { const url = new URL(endpoint); url.searchParams.set("id", "sku-123"); const url2 = new URL(productPath, externalRoot); url2.searchParams.set("id", "sku-123"); return [url.href, url2.href]; }\n';
    await writeFile(path.join(fixtureThemeDir, 'modules', 'config.js'), configSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'imported.js'), importedSource);
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: theme,
      extraFiles: {
        'modules/config.js': configSource,
        'modules/imported.js': importedSource,
        'modules/layout.js': [
          'export function mount() {',
          '  const productUrl = "https://example.test/product?id=sku-123";',
          '  const routeKey = "tab";',
          '  const url = new URL("https://analytics.example.test/collect");',
          '  url.searchParams.set(routeKey, "posts");',
          '  url.searchParams.set("utm_source", "press-theme");',
          '  const productParams = new URLSearchParams({ id: "sku-123" });',
          '  const stringParams = new URLSearchParams("id=sku-123");',
          '  const layoutParams = new URLSearchParams({ grid: "dense" });',
          '  const externalBase = "https://example.test/product";',
          '  const externalRoot = "https://example.test";',
          '  const productPath = "/product";',
          '  const externalUrlObjectBase = new URL("https://example.test");',
          '  const externalRouteKey = "id";',
          '  const splitInlineExternal = externalBase + "?id=" + "sku-123";',
          '  const splitLiteralExternal = "https://example.test/product" + "?tab=posts";',
          '  const externalUrl = new URL(externalBase);',
          '  externalUrl.searchParams.set("id", "sku-123");',
          '  const externalUrlWithBase = new URL(externalBase, window.location.href);',
          '  externalUrlWithBase.searchParams.set("id", "sku-123");',
          '  const externalUrlFromBase = new URL("/product", externalBase);',
          '  externalUrlFromBase.searchParams.set("id", "sku-123");',
          '  const externalUrlFromPathAlias = new URL(productPath, externalRoot);',
          '  externalUrlFromPathAlias.searchParams.set("id", "sku-123");',
          '  const externalUrlFromObjectBase = new URL(productPath, externalUrlObjectBase);',
          '  externalUrlFromObjectBase.searchParams.set("id", "sku-123");',
          '  const externalUrlWithQueryFromBase = new URL("/product?id=sku-123", externalBase);',
          '  const derivedExternalUrl = new URL(externalBase + "/details", window.location.href);',
          '  derivedExternalUrl.searchParams.set("id", "sku-123");',
          '  const templateExternalUrl = new URL(`${externalBase}/variant`, window.location.href);',
          '  templateExternalUrl.searchParams.set("id", "sku-123");',
          '  return { productUrl, objectUrl: "https://example.test/product?" + productParams, inlineObjectUrl: "https://example.test/product?" + new URLSearchParams({ id: "sku-123" }), inlineTemplateUrl: `https://example.test/product?${new URLSearchParams({ id: "sku-123" })}`, aliasInlineTemplateUrl: `${externalBase}?${new URLSearchParams({ id: "sku-123" })}`, stringUrl: "https://example.test/product?" + stringParams, aliasStringUrl: externalBase + "?" + stringParams, grid: "https://example.test/layout?" + layoutParams, splitInlineExternal, splitLiteralExternal, splitUrl: externalBase + "?" + "id=" + "sku-123", splitKeyUrl: externalBase + "?" + "id" + "=" + "sku-123", aliasSplitUrl: externalBase + "?" + externalRouteKey + "=" + "sku-123", aliasTemplateUrl: `${externalBase}?${externalRouteKey}=sku-123`, url: url.href, externalUrl: externalUrl.href, externalUrlWithBase: externalUrlWithBase.href, externalUrlFromBase: externalUrlFromBase.href, externalUrlFromPathAlias: externalUrlFromPathAlias.href, externalUrlFromObjectBase: externalUrlFromObjectBase.href, externalUrlWithQueryFromBase: externalUrlWithQueryFromBase.href, derivedExternalUrl: derivedExternalUrl.href, templateExternalUrl: templateExternalUrl.href };',
          '}'
        ].join('\n')
      }
    });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 4;
    release.engines.press = '>=3.4.130 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.6.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    release.files = [
      'modules/config.js',
      'modules/imported.js',
      'modules/layout.js',
      'theme.css',
      'theme.json'
    ];
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, true);
  });
});

async function assertV4PackagedSourceRejected(source, file = 'modules/interactions.js', extraFiles = {}) {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 4,
      pressRange: '>=3.4.130 <4.0.0'
    });
    await writeJson(themePath, theme);
    const fixtureThemeDir = path.dirname(themePath);
    for (const [relativePath, contents] of Object.entries({ ...extraFiles, [file]: `${source}\n` })) {
      const fullPath = path.join(fixtureThemeDir, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents);
    }
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: theme,
      extraFiles: {
        ...extraFiles,
        [file]: `${source}\n`
      }
    });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 4;
    release.engines.press = '>=3.4.130 <4.0.0';
    release.asset.name = 'press-theme-arcus-v3.4.6.zip';
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    release.files = [
      ...Object.keys(extraFiles),
      file,
      'modules/layout.js',
      'theme.css',
      'theme.json'
    ].sort();
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contract v4 ZIP packaged source must use router href helpers/u);
  });
}

test('verifyCatalog rejects v3 range clauses that allow pre-transition Press versions', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const pressRange = '>=3.4.0 <3.4.1 || >=3.4.127 <4.0.0';
    const theme = createThemeManifest({ pressRange });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.engines.press = pressRange;
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contract v3 engines\.press must not accept Press versions before 3\.4\.127/u);
  });
});

test('verifyCatalog rejects legacy v1 theme releases', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({ contractVersion: 1 });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson: theme });
    const bytes = await readFile(zipPath);
    release.contractVersion = 1;
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contractVersion must be supported/u);
  });
});

test('verifyCatalog rejects duplicate catalog identities and wrong repository URLs', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, catalog }) => {
    catalog.themes.push({
      ...catalog.themes[0],
      repo: 'EkilyHQ/Press-Theme-Wrong',
      manifestUrl: 'https://raw.githubusercontent.com/EkilyHQ/Press-Theme-Wrong/main/theme-release.json'
    });
    await writeJson(catalogPath, catalog);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: false,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /duplicates arcus/u);
    assert.match(result.failures.join('\n'), /repo must be EkilyHQ\/Press-Theme-Arcus/u);
  });
});

test('verifyCatalog rejects ZIP assets with a wrong digest', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release }) => {
    release.asset.digest = `sha256:${'0'.repeat(64)}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /asset digest/u);
  });
});

test('verifyCatalog rejects ZIP inventory that differs from theme-release files', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, tempDir }) => {
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      extraFiles: {
        'extra.txt': 'not declared\n'
      }
    });
    const bytes = await readFile(zipPath);
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /ZIP file inventory/u);
  });
});

test('verifyCatalog rejects ZIP assets with duplicate file paths', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, tempDir }) => {
    const zipPath = await createDuplicatePathZip(tempDir, 'arcus');
    const bytes = await readFile(zipPath);
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /duplicate paths/u);
  });
});

test('verifyCatalog rejects ZIP theme manifest drift from theme-release', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, tempDir }) => {
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: {
        ...createThemeManifest(),
        version: '9.9.9'
      }
    });
    const bytes = await readFile(zipPath);
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /ZIP theme\.json version must match release version/u);
  });
});

test('verifyCatalog rejects ZIP theme manifests without declared modules', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, tempDir }) => {
    const { modules, ...themeJson } = createThemeManifest();
    const zipPath = await createThemeZip(tempDir, 'arcus', { themeJson });
    const bytes = await readFile(zipPath);
    release.asset.url = pathToFileURL(zipPath).href;
    release.asset.size = bytes.length;
    release.asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.127'
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /ZIP theme\.json modules must be a non-empty array/u);
  });
});

test('verifyCatalog requires a resolvable Press version', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot }) => {
    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot: path.join(workspaceRoot, 'missing-press'),
      remote: false,
      verifyAssets: false,
      fetchImpl: async () => {
        throw new Error('network disabled');
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /Press version could not be resolved/u);
  });
});

async function withFixture(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'press-theme-catalog-test-'));
  try {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const catalogRoot = path.join(tempDir, 'catalog');
    const themeRepo = path.join(workspaceRoot, 'Press-Theme-Arcus');
    await mkdir(path.join(workspaceRoot, 'Press', 'assets'), { recursive: true });
    await mkdir(catalogRoot, { recursive: true });
    await mkdir(path.join(themeRepo, 'theme', 'modules'), { recursive: true });

    await writeJson(path.join(workspaceRoot, 'Press', 'assets', 'press-system.json'), {
      schemaVersion: 1,
      type: 'press-system',
      version: '3.4.127',
      tag: 'v3.4.127'
    });
    const themePath = path.join(themeRepo, 'theme', 'theme.json');
    await writeJson(themePath, createThemeManifest());
    await writeFile(path.join(themeRepo, 'theme', 'theme.css'), ':root{}\n');
    await writeFile(path.join(themeRepo, 'theme', 'modules', 'layout.js'), 'export function mount() {}\n');

    const zipPath = await createThemeZip(tempDir, 'arcus');
    const bytes = await readFile(zipPath);
    const release = {
      schemaVersion: 1,
      type: 'press-theme',
      value: 'arcus',
      label: 'Arcus',
      version: '3.4.2',
      contractVersion: 3,
      engines: {
        press: '>=3.4.127 <4.0.0'
      },
      asset: {
        name: 'press-theme-arcus-v3.4.2.zip',
        url: pathToFileURL(zipPath).href,
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      },
      files: [
        'modules/layout.js',
        'theme.css',
        'theme.json'
      ]
    };
    const releasePath = path.join(themeRepo, 'theme-release.json');
    await writeJson(releasePath, release);

    const catalog = {
      schemaVersion: 1,
      themes: [
        {
          value: 'arcus',
          label: 'Arcus',
          repo: 'EkilyHQ/Press-Theme-Arcus',
          manifestUrl: 'https://raw.githubusercontent.com/EkilyHQ/Press-Theme-Arcus/main/theme-release.json',
          description: 'Fixture theme.'
        }
      ]
    };
    const catalogPath = path.join(catalogRoot, 'catalog.json');
    await writeJson(catalogPath, catalog);

    await callback({
      catalogPath,
      workspaceRoot,
      releasePath,
      themePath,
      release,
      catalog,
      tempDir
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function createThemeZip(tempDir, slug, options = {}) {
  const packageRoot = path.join(tempDir, `package-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const rootName = `press-theme-${slug}`;
  const root = path.join(packageRoot, rootName);
  await mkdir(path.join(root, 'modules'), { recursive: true });
  await writeJson(path.join(root, 'theme.json'), options.themeJson || createThemeManifest());
  await writeFile(path.join(root, 'theme.css'), ':root{}\n');
  await writeFile(path.join(root, 'modules', 'layout.js'), 'export function mount() {}\n');
  for (const [relativePath, contents] of Object.entries(options.extraFiles || {})) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
  const zipPath = path.join(tempDir, `${rootName}-${Date.now()}.zip`);
  const result = spawnSync('zip', ['-qr', zipPath, rootName], {
    cwd: packageRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'zip failed').trim());
  }
  return zipPath;
}

function createThemeManifest(options = {}) {
  const version = options.version || '3.4.2';
  const contractVersion = Number.isFinite(Number(options.contractVersion)) ? Number(options.contractVersion) : 3;
  const pressRange = options.pressRange || '>=3.4.127 <4.0.0';
  return {
    name: 'Arcus',
    version,
    contractVersion,
    engines: {
      press: pressRange
    },
    styles: ['theme.css'],
    modules: ['modules/layout.js']
  };
}

async function createDuplicatePathZip(tempDir, slug) {
  const rootName = `press-theme-${slug}`;
  const manifest = Buffer.from(`${JSON.stringify(createThemeManifest(), null, 2)}\n`);
  const entries = [
    [`${rootName}/theme.json`, manifest],
    [`${rootName}/theme.css`, Buffer.from(':root{}\n')],
    [`${rootName}/modules/layout.js`, Buffer.from('export function mount() {}\n')],
    [`${rootName}/theme.json`, manifest]
  ];
  const zipPath = path.join(tempDir, `${rootName}-duplicate-${Date.now()}.zip`);
  await writeFile(zipPath, buildStoredZip(entries));
  return zipPath;
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  entries.forEach(([name, contents]) => {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(contents);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
