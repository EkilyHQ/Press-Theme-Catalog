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

test('verifyCatalog does not apply v4 packaged route scan to v3 ZIP assets', async () => {
  await withFixture(async ({ catalogPath, workspaceRoot, releasePath, release, themePath, tempDir }) => {
    const theme = createThemeManifest({
      version: '3.4.6',
      contractVersion: 3,
      pressRange: '>=3.4.127 <4.0.0'
    });
    await writeJson(themePath, theme);
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: theme,
      extraFiles: {
        'modules/layout.js': 'export function mount() { return "?tab=posts"; }\n'
      }
    });
    const bytes = await readFile(zipPath);
    release.version = '3.4.6';
    release.contractVersion = 3;
    release.engines.press = '>=3.4.127 <4.0.0';
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

    assert.equal(result.ok, true, result.failures.join('\n'));
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
        'assets/link.html': '<a href="?id=post.md">Post</a>\n<a href=?tab=posts>Posts</a>',
        'modules/config.js': 'const routeKey = "id"; export default routeKey;\n',
        'modules/config-local-default.js': 'const routeKey = "id"; export { routeKey as default };\n',
        'modules/layout.js': 'export const href = "?lang=en&tab=posts";\n',
        'modules/views.js': 'export const postHref = "?id=post.md";\n',
        'modules/interactions.js': [
          'import routeKeyDefault from "./config.js";',
          'import routeKeyLocalDefault from "./config-local-default.js";',
          'export function route(post, tab) {',
          '  const url = new URL(location.href);',
          '  url.searchParams.set("id", "post.md");',
          '  url.searchParams.set(routeKeyDefault, post.id);',
          '  url.searchParams.set(routeKeyLocalDefault, post.id);',
          '  const boundSet = url.searchParams.set.bind(url.searchParams);',
          '  boundSet("id", post.id);',
          '  const boundDelete = url.searchParams.delete.bind(url.searchParams);',
          '  boundDelete("id");',
          '  const key = "tab";',
          '  url.searchParams.set(key, tab);',
          '  const unused = 1, multiDeclaratorKey = "id";',
          '  url.searchParams.set(multiDeclaratorKey, post.id);',
          '  const routeKeys = { post: "id" };',
          '  url.searchParams.set(routeKeys.post, post.id);',
          '  url.searchParams.delete("tab");',
          '  const params = new URLSearchParams();',
          '  params.set("tab", "posts");',
          '  const objectParams = new URLSearchParams({ id: post.id });',
          '  const entriesParams = new URLSearchParams(Object.entries({ id: post.id }));',
          '  const mapParams = new URLSearchParams(new Map([["id", post.id]]));',
          '  const parenthesizedObjectParams = (new URLSearchParams({ id: post.id }));',
          '  const objectQuery = objectParams.toString();',
          '  const queryAlias = "id=" + post.id;',
          '  const parenthesizedQueryAlias = ("id=" + post.id);',
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
          '  location.search =',
          '    "id=" + post.id;',
          '  location.search = new URLSearchParams([["tab", tab]]).toString();',
          '  location.search = new URLSearchParams(Object.entries({ id: post.id }));',
          '  location.search = "id=" + post.id;',
          '  location.search = `${routeKey}=${post.location}`;',
          '  location.search += routeKey + "=" + post.location;',
          '  let assignedUrl;',
          '  assignedUrl = new URL(location.href);',
          '  assignedUrl.searchParams.set("id", post.id);',
          '  assignedUrl.search = routeKey + "=" + post.id;',
          '  assignedUrl.search = routeKey +',
          '    "=" + post.id;',
          '  assignedUrl.search = new URLSearchParams({ id: post.id });',
          '  state.routeUrl = new URL(location.href);',
          '  state.routeUrl.searchParams.set("id", post.id);',
          '  function currentUrl() { return new URL(location.href); }',
          '  const factoryUrl = currentUrl();',
          '  factoryUrl.searchParams.set("id", post.id);',
          '  const WindowParams = window.URLSearchParams;',
          '  const aliasedWindowParams = new WindowParams({ id: post.id });',
          '  const conditionalParams = enabled ? new URLSearchParams({ id: post.id }) : new URLSearchParams();',
          '  const multilineUrl = new URL(',
          '    location.href',
          '  );',
          '  multilineUrl.searchParams.set("id", post.id);',
          '  const externalBase = "https://api.example.test";',
          '  const currentUrlWithExternalBase = new URL(location.href, externalBase);',
          '  currentUrlWithExternalBase.searchParams.set("id", post.id);',
          '  return ["?" + params, "?" + objectParams, "?" + entriesParams, "?" + mapParams, "?" + String(objectParams), "?" + parenthesizedObjectParams, "?" + objectQuery, "?" + queryAlias, "?" + parenthesizedQueryAlias, `?${arrayParams}`, "?" + aliasParams, "?" + splitParams, "?" + multilineParams, "?" + shorthandParams, "?" + new URLSearchParams({ id: post.id }), "?" + (new URLSearchParams({ id: post.id })), `?${new URLSearchParams({ id: post.id })}`, "?" + new URLSearchParams(`${routeKey}=${post.location}`), `?${new URLSearchParams(`${routeKey}=${post.location}`)}`, "?" + aliasedWindowParams, "?" + conditionalParams, `?${routeKey}=${post.location}`, "?" + routeKey + "=" + post.location, "?" + "id=" + post.id, "?" + "id" + "=" + post.id, url.href, assignedUrl.href, state.routeUrl.href, factoryUrl.href, multilineUrl.href, currentUrlWithExternalBase.href];',
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
    'export function route(post) { return "?" + ("id=" + post.id); }',
    'export function route(post) { return "?" + (`id=${post.id}`); }',
    'export function route(post) { return "?" + ("i" + "d" + "=" + post.id); }',
    'export function route() { const key = "id"; const url = new URL(location.href); url.searchParams.set((key), "post.md"); return url.href; }',
    'export function route() { const url = new URL(location.href); url.searchParams.set(("id"), "post.md"); return url.href; }',
    'export function route() { const url = new URL(location.href); url.searchParams.set((("id")), "post.md"); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.set("i" + "d", post.id); return url.href; }',
    'export function route(post) { const unused = 1, key = "id"; const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'export function route(post) { const key = "\\u0069d"; const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'export function route(post) { const routeKeys = { post: "id" }; const url = new URL(location.href); url.searchParams.set(routeKeys.post, post.id); return url.href; }',
    'export function route(post) { const routeKeys = { post: "\\u0069d" }; const url = new URL(location.href); url.searchParams.set(routeKeys.post, post.id); return url.href; }',
    'export function route(post) { const routeKeys = { post: "id" }; const url = new URL(location.href); url.searchParams.set(routeKeys["post"], post.id); return url.href; }',
    'export function route(post) { const routeKeys = { post: "id" }; const url = new URL(location.href); url.searchParams.set(routeKeys?.["post"], post.id); return url.href; }',
    'export const href = "?\\u0069d=post.md";',
    'export const href = "?%69d=post.md";',
    'export const href = "?ta%62=posts";',
    'export function route(post) { let params; params = new URLSearchParams({ id: post.id }); return "?" + params; }',
    'export function route(post) { const Params = URLSearchParams; const params = new Params({ id: post.id }); return "?" + params; }',
    'export function route(post) { const WindowParams = window.URLSearchParams; const params = new WindowParams({ id: post.id }); return "?" + params; }',
    'export function route(post) { const Params = globalThis.URLSearchParams; const params = new Params({ id: post.id }); return "?" + params; }',
    'export function route(post) { const { URLSearchParams: Params } = window; const params = new Params({ id: post.id }); return "?" + params; }',
    'export function route(post) { const params = new URLSearchParams([["i" + "d", post.id]]); return "?" + params; }',
    'export function route(post) { const params = enabled ? new URLSearchParams({ id: post.id }) : new URLSearchParams(); return "?" + params; }',
    'export function route(post) { const url = new URL(location.href); const params = url.searchParams; params.set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const prop = "searchParams"; url[prop].set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.delete("id"); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.set.call(url.searchParams, "id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.set.apply(url.searchParams, ["id", post.id]); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.set?.call(url.searchParams, "id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.searchParams.set?.apply(url.searchParams, ["id", post.id]); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const remove = url.searchParams.delete.bind(url.searchParams); remove("id"); return url.href; }',
    'export function route(post) { const params = new URLSearchParams(); const set = params.set; set.call(params, "id", post.id); return "?" + params; }',
    'export function route(post) { const key = "tab"; const url = new URL(location.href); let params; params = url.searchParams; params.append(key, "posts"); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const params = (url.searchParams); params.set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const { searchParams } = url; searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const url = new URL(location.href); const { searchParams: params } = url; params.set("id", post.id); return url.href; }',
    'export function route(post) { const params = new URL(location.href).searchParams; params.set("id", post.id); return "?" + params; }',
    'export function route(post) { new URL(location.href).searchParams.set("id", post.id); }',
    'export function route(post) { const url = new window.URL(location.href); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const Url = URL; const url = new Url(location.href); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const { URL: Url } = window; const url = new Url(location.href); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const { searchParams } = new URL(location.href); searchParams.set("id", post.id); return `?${searchParams}`; }',
    'export function route(post) { const params = new URLSearchParams(Object.entries({ id: post.id })); return "?" + params; }',
    'export function route(post) { const params = new URLSearchParams(Object.fromEntries([["id", post.id]])); return "?" + params; }',
    'export function route(post) { const params = new URLSearchParams(new Map([["id", post.id]])); return "?" + params; }',
    'export function route(post) { const params = new URLSearchParams({ id: post.id }); return "?" + String(params); }',
    'export function route(post) { const qs = "id=" + post.id; location.search = qs; }',
    'export function route(post) { location.search =\n  "id=" + post.id; }',
    'export function route(post) { location.search = new URLSearchParams(Object.entries({ id: post.id })); }',
    'export function route(post) { const key = "id"; let qs; qs = key + "=" + post.id; location.search = qs.toString(); }',
    'export function route(post) { const loc = location; const key = "id"; const qs = key + "=" + post.id; loc.search = qs; }',
    'export function route(post) { const key = "id"; window.location["search"] = key + "=" + post.id; }',
    'export function route(post) { const loc = location; const key = "id"; loc["search"] = key + "=" + post.id; }',
    'export function route(post) { const { location: loc } = window; const key = "id"; const qs = key + "=" + post.id; loc.search = qs; }',
    'export function route(post) { const loc = window.location; const params = new URLSearchParams({ id: post.id }); loc.search = params; }',
    'export function route(post) { const qs = enabled ? "id=" + post.id : ""; location.search = qs; }',
    'export function route(post) { const key = "id"; const url = new URL(location.href); url.search = key + "=" + post.id; return url.href; }',
    'export function route(post) { const key = "id"; const url = new URL(location.href); url.search = key +\n  "=" + post.id; return url.href; }',
    'export function route(post) { const url = new URL(location.href); url.search = new URLSearchParams({ id: post.id }); return url.href; }',
    'export function route(post) { new URL(location.href).search = "id=" + post.id; }',
    'export function route(post) { new URL(location.href)["search"] = "id=" + post.id; }',
    'export function route(post) { state.url = new URL(location.href); state.url.searchParams.set("id", post.id); return state.url.href; }',
    'export function route(post) { function currentUrl() { return new URL(location.href); } const url = currentUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const currentUrl = function() { return new URL(location.href); }; const url = currentUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { const currentUrl = _ => new URL(location.href); const url = currentUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'export function route(post) { function currentUrl() { return new URL(location.href); } currentUrl().searchParams.set("id", post.id); }',
    'export function route(post) { const helper = { mutate: (url) => { url.searchParams.set("id", post.id); return url.href; } }; return helper.mutate(new URL(location.href)); }',
    'export function route(post) { const helper = { mutate: function(url) { url.searchParams.set("id", post.id); return url.href; } }; return helper.mutate(new URL(location.href)); }',
    'export function route(post) { const helper = { routes: { mutate(url) { url.searchParams.set("id", post.id); return url.href; } } }; return helper.routes.mutate(new URL(location.href)); }',
    'export function route(post) { let endpoint = "https://api.example.test/product"; endpoint = location.href; const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; }',
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
    'import routeKey from "./config.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(routeKey, post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export default "\\u0069d";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function route(post) { const url = makeUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import makeUrl from "./url.js"; export function route(post) { const url = makeUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/url.js': 'export default function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import makeUrl from "./url.js"; export function route(post) { const url = makeUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/url.js': 'export default (function makeUrl() { return new URL(location.href); });\n' }
  );
  await assertV4PackagedSourceRejected(
    'import makeUrl from "./url.js"; export function route(post) { const url = makeUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/url.js': 'export default (() => new URL(location.href));\n' }
  );
  await assertV4PackagedSourceRejected(
    'import makeUrl from "./url.js"; export function route(post) { makeUrl().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'const makeUrl = () => new URL(location.href); export { makeUrl as default };\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function route(post) { makeUrl().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { const marker = "function fake() {"; return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function route(post) { const url = makeProductUrl(location.href); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const externalRoot = "https://api.example.test";\n',
      'modules/url.js': 'import { externalRoot } from "./config.js"; export function makeProductUrl(externalRoot) { return new URL("/product", externalRoot); }\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function route(post) { const url = makeProductUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const externalRoot = "https://api.example.test";\n',
      'modules/url.js': 'import { externalRoot } from "./config.js"; export function makeProductUrl() { const marker = "{"; const externalRoot = location.href; return new URL("/product", externalRoot); }\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function route(post) { const url = makeProductUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const externalRoot = "https://api.example.test";\n',
      'modules/url.js': 'import { externalRoot } from "./config.js"; export function makeProductUrl() { if (ok) { const externalRoot = location.href; return new URL("/product", externalRoot); } return new URL("/fallback", "https://api.example.test"); }\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function route(post) { const url = makeProductUrl(); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const externalRoot = "https://api.example.test";\n',
      'modules/url.js': 'import { externalRoot } from "./config.js"; export function makeProductUrl() { const [externalRoot] = [location.href]; return new URL("/product", externalRoot); }\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import * as config from "./config.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(config.key, post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const key = "id";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(endpoint, post) { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route({ endpoint }, post) { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export default (endpoint, post) => { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => endpoint + "?id=" + post.id;',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => ((url) => (url.searchParams.set("id", post.id), url.href))(new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => ((url) => { url.searchParams.set("id", post.id); return url.href; })(new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => (function(url) { url.searchParams.set("id", post.id); return url.href; })(new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => (async function(url) { url.searchParams.set("id", post.id); return url.href; })(new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { const mutate = (url) => { url.searchParams.set("id", post.id); return url.href; }; return mutate(new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { const mutate = (url) => (url.searchParams.set("id", post.id), url.href); return mutate(new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => ((url) => (url.searchParams.set("id", post.id), url.href)).call(null, new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => ((url) => (url.searchParams.set("id", post.id), url.href)).call(getThis(a, b), new URL(endpoint));',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => ((url) => (url.searchParams.set("id", post.id), url.href)).apply(null, [new URL(endpoint)]);',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { function mutate(url) { url.searchParams.set("id", post.id); return url.href; } return mutate.call(null, new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { function mutate(url) { url.searchParams.set("id", post.id); return url.href; } return mutate.apply(null, [new URL(endpoint)]); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { const helper = { mutate(url) { url.searchParams.set("id", post.id); return url.href; } }; return helper.mutate(new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { function mutate(url) { url.searchParams.set("id", post.id); return url.href; } const bound = mutate.bind(null); return bound(new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { function mutate(url) { url.searchParams.set("id", post.id); return url.href; } const bound = mutate.bind(null, new URL(endpoint)); return bound(); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = ({ endpoint }, post) => { function mutate(ctx, url) { url.searchParams.set("id", post.id); return url.href; } return mutate(null, new URL(endpoint)); };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'export function route(a, b) { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } if (a) { function mutate(url) { return url.href; } } if (b) { return mutate(new URL(location.href)); } return null; }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { function mutate(url) { url.searchParams.set("id", post.location); return url.href; } return mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { function mutate(url) { url.search = "id=" + post.location; return url.href; } return mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { const helper = { mutate(ctx, url) { url.searchParams.set("id", "post.md"); return url.href; } }; return helper.mutate(null, new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { const url = new URL(location.href); url.searchParams["set"]("id", post.location); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { const url = new URL(location.href); url["searchParams"]?.["append"]("tab", "posts"); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { const url = new URL(location.href); url.searchParams.set?.("id", post.location); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { const url = new URL(location.href); const params = url["searchParams"]; params.set("id", post.location); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } return mutate((new URL(location.href))); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } return mutate.call(null, (new URL(location.href))); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } return mutate.apply(null, [(new URL(location.href))]); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { return ((url) => (url.searchParams.set("id", "post.md"), url.href))((new URL(location.href))); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } return mutate?.(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } mutate?.call(null, new URL(location.href)); mutate?.apply(null, [new URL(location.href)]); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } return mutate["call"](null, new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { return ((ctx, url) => { url.searchParams.set("id", "post.md"); return url.href; })("ctx", new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { return (function(ctx, url) { url.searchParams.set("id", "post.md"); return url.href; }).call(null, "ctx", new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { return ((ctx, url) => (url.searchParams.set("id", "post.md"), url.href)).call(null, "ctx", new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { return ((ctx, url) => (url.searchParams.set("id", "post.md"), url.href)).apply(null, ["ctx", new URL(location.href)]); }'
  );
  await assertV4PackagedSourceRejected(
    [
      'import { endpoint } from "./config.js";',
      'export const route = ({ endpoint }, post) => (',
      '  endpoint + "?id=" + post.id',
      ');'
    ].join('\n'),
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export default endpoint => endpoint + "?tab=posts";',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export const route = async endpoint => { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; };',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route({ endpoint = location.href }, post) { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export default { route({ endpoint }, post) { const url = new URL(endpoint); url.searchParams.set("id", post.id); return url.href; } };',
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
  await assertV4PackagedSourceRejected(
    'import { key } from "./barrel.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const key = "id";\n',
      'modules/barrel.js': 'export { key } from "./config.js";\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { key } from "./barrel.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const key = "id";\n',
      'modules/barrel.js': 'import { key } from "./config.js"; export { key };\n'
    }
  );
  await assertV4PackagedSourceRejected(
    'import { key } from "./barrel.js"; export function route(post) { const url = new URL(location.href); url.searchParams.set(key, post.id); return url.href; }',
    'modules/interactions.js',
    {
      'modules/config.js': 'export const key = "id";\n',
      'modules/barrel.js': 'export * from "./config.js";\n'
    }
  );
});

test('verifyCatalog scans v4 SVG and HTML packaged route attributes', async () => {
  await assertV4PackagedSourceRejected('<svg><a href="?id=post.md"/></svg>', 'assets/icon.svg');
  await assertV4PackagedSourceRejected('<a href=?id=post.md>Post</a>', 'assets/link.html');
  await assertV4PackagedSourceRejected('<a href="?id&#61;post.md">Post</a>', 'assets/escaped-equals.html');
  await assertV4PackagedSourceRejected('<a href="?foo=1&amp;id=post.md">Post</a>', 'assets/escaped-amp.html');
  await assertV4PackagedSourceRejected('<a href="?&#105;d=post.md">Post</a>', 'assets/escaped-key.html');
  await assertV4PackagedSourceRejected('<a href="&#00063;id&#00061;post.md">Post</a>', 'assets/padded-escaped-query.html');
  await assertV4PackagedSourceRejected('<p>https://example.test</p><a href="?id=post.md">Post</a>', 'assets/https-before-link.html');
  await assertV4PackagedSourceRejected('<img srcset="?id=post.md 1x, ?tab=posts 2x">', 'assets/srcset.html');
  await assertV4PackagedSourceRejected('<script>location.search = "id=" + post.location;</script>', 'assets/inline-script.html');
  await assertV4PackagedSourceRejected('<script>location.search = "id=" + post.location;</script\t\n data-x>', 'assets/loose-inline-script.html');
  await assertV4PackagedSourceRejected(`<button onclick="location.search = '?id=post.md'">Open</button>`, 'assets/event-handler.html');
});

test('verifyCatalog does not scan static v4 assets as executable route code', async () => {
  await assertV4PackagedSourceAccepted('body { background: url("/sprite.svg?id=foo"); }', 'theme.css');
  await assertV4PackagedSourceAccepted('{"href":"?tab=posts"}', 'assets/data.json');
  await assertV4PackagedSourceAccepted('<script type="application/json">{"href":"?id=post.md"}</script>', 'assets/data.html');
  await assertV4PackagedSourceAccepted('old docs: "?id=post.md"', 'assets/notes.txt');
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
    const configSource = 'const defaultEndpoint = "https://api.example.test/product"; export default defaultEndpoint; export const endpoint = "https://api.example.test/product"; export const productPath = "/product"; export const externalRoot = "https://api.example.test";\n';
    const barrelSource = 'export { endpoint } from "./config.js";\n';
    const localExportBarrelSource = 'import { endpoint } from "./config.js"; export { endpoint };\n';
    const starBarrelSource = 'export * from "./config.js";\n';
    const importedSource = 'import defaultEndpoint, { endpoint, productPath, externalRoot } from "./config.js"; import { endpoint as barrelEndpoint } from "./barrel.js"; import { endpoint as localExportEndpoint } from "./local-export-barrel.js"; import { endpoint as starEndpoint } from "./star-barrel.js"; export function imported() { const url = new URL(endpoint); url.searchParams.set("id", "sku-123"); const url2 = new URL(productPath, externalRoot); url2.searchParams.set("id", "sku-123"); const url3 = new URL(barrelEndpoint); url3.searchParams.set("id", "sku-123"); const url4 = new URL(localExportEndpoint); url4.searchParams.set("id", "sku-123"); const url5 = new URL(starEndpoint); url5.searchParams.set("id", "sku-123"); const importedTemplateUrl = `${endpoint}?id=sku-123`; const qs = "id=" + "sku-123"; const importedTemplateAliasUrl = `${endpoint}?${qs}`; const importedConcatAliasUrl = endpoint + "?" + qs; const defaultTemplateAliasUrl = `${defaultEndpoint}?${qs}`; return [url.href, url2.href, url3.href, url4.href, url5.href, importedTemplateUrl, importedTemplateAliasUrl, importedConcatAliasUrl, defaultTemplateAliasUrl]; }\n';
    const externalFactorySource = 'import { externalRoot } from "./config.js"; export function makeProductUrl() { return new URL("/product", externalRoot); }\n';
    const externalFactoryUserSource = 'import { makeProductUrl } from "./external-factory.js"; export function useFactory() { const url = makeProductUrl(); url.searchParams.set("id", "sku-123"); return url.href; }\n';
    const externalFactorySiblingShadowSource = 'import { externalRoot } from "./config.js"; export function makeProductUrlWithSiblingShadow() { if (ok) { const externalRoot = location.href; void externalRoot; } return new URL("/product", externalRoot); }\n';
    const externalFactorySiblingShadowUserSource = 'import { makeProductUrlWithSiblingShadow } from "./external-factory-sibling-shadow.js"; export function useFactory() { const url = makeProductUrlWithSiblingShadow(); url.searchParams.set("id", "sku-123"); return url.href; }\n';
    const externalFactoryNestedVarSource = 'import { externalRoot } from "./config.js"; export function makeProductUrlWithNestedVar() { function helper() { var externalRoot = location.href; return externalRoot; } void helper; return new URL("/product", externalRoot); }\n';
    const externalFactoryNestedVarUserSource = 'import { makeProductUrlWithNestedVar } from "./external-factory-nested-var.js"; export function useFactory() { const url = makeProductUrlWithNestedVar(); url.searchParams.set("id", "sku-123"); return url.href; }\n';
    const externalFactoryFakeDeclarationSource = 'import { externalRoot } from "./config.js"; export function makeProductUrlWithFakeDeclaration() { const marker = "const externalRoot = x"; return new URL("/product", externalRoot); }\n';
    const externalFactoryFakeDeclarationUserSource = 'import { makeProductUrlWithFakeDeclaration } from "./external-factory-fake-declaration.js"; export function useFactory() { const url = makeProductUrlWithFakeDeclaration(); url.searchParams.set("id", "sku-123"); return url.href; }\n';
    const externalFactoryNestedImportedNameSource = 'export function makeProductUrl() { return new URL("/product", "https://api.example.test"); }\n';
    const externalFactoryNestedImportedNameUserSource = 'import { makeProductUrl } from "./external-factory-nested-imported-name.js"; export function useFactory() { function setup() { function makeProductUrl() { return new URL(location.href); } void makeProductUrl; } void setup; const url = makeProductUrl(); url.searchParams.set("id", "sku-123"); return url.href; }\n';
    await writeFile(path.join(fixtureThemeDir, 'modules', 'config.js'), configSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'barrel.js'), barrelSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'local-export-barrel.js'), localExportBarrelSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'star-barrel.js'), starBarrelSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'imported.js'), importedSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory.js'), externalFactorySource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-user.js'), externalFactoryUserSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-sibling-shadow.js'), externalFactorySiblingShadowSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-sibling-shadow-user.js'), externalFactorySiblingShadowUserSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-nested-var.js'), externalFactoryNestedVarSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-nested-var-user.js'), externalFactoryNestedVarUserSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-fake-declaration.js'), externalFactoryFakeDeclarationSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-fake-declaration-user.js'), externalFactoryFakeDeclarationUserSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-nested-imported-name.js'), externalFactoryNestedImportedNameSource);
    await writeFile(path.join(fixtureThemeDir, 'modules', 'external-factory-nested-imported-name-user.js'), externalFactoryNestedImportedNameUserSource);
    const zipPath = await createThemeZip(tempDir, 'arcus', {
      themeJson: theme,
      extraFiles: {
        'modules/config.js': configSource,
        'modules/barrel.js': barrelSource,
        'modules/local-export-barrel.js': localExportBarrelSource,
        'modules/star-barrel.js': starBarrelSource,
        'modules/imported.js': importedSource,
        'modules/external-factory.js': externalFactorySource,
        'modules/external-factory-user.js': externalFactoryUserSource,
        'modules/external-factory-sibling-shadow.js': externalFactorySiblingShadowSource,
        'modules/external-factory-sibling-shadow-user.js': externalFactorySiblingShadowUserSource,
        'modules/external-factory-nested-var.js': externalFactoryNestedVarSource,
        'modules/external-factory-nested-var-user.js': externalFactoryNestedVarUserSource,
        'modules/external-factory-fake-declaration.js': externalFactoryFakeDeclarationSource,
        'modules/external-factory-fake-declaration-user.js': externalFactoryFakeDeclarationUserSource,
        'modules/external-factory-nested-imported-name.js': externalFactoryNestedImportedNameSource,
        'modules/external-factory-nested-imported-name-user.js': externalFactoryNestedImportedNameUserSource,
        'modules/layout.js': [
          '// old route literal fixture: "?id=post.md"',
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
          '  const Url = URL;',
          '  const externalAliasUrl = new Url(externalBase);',
          '  externalAliasUrl.searchParams.set("id", "sku-123");',
          '  const externalBracketUrl = new URL(externalBase);',
          '  externalBracketUrl.searchParams["set"]("id", "sku-123");',
          '  const externalOptionalCallUrl = new URL(externalBase);',
          '  externalOptionalCallUrl.searchParams.set?.("id", "sku-123");',
          '  const externalUrlWithBase = new URL(externalBase, window.location.href);',
          '  externalUrlWithBase.searchParams.set("id", "sku-123");',
          '  const externalUrlFromBase = new URL("/product", externalBase);',
          '  externalUrlFromBase.searchParams.set("id", "sku-123");',
          '  const externalUrlFromPathAlias = new URL(productPath, externalRoot);',
          '  externalUrlFromPathAlias.searchParams.set("id", "sku-123");',
          '  const externalUrlFromObjectBase = new URL(productPath, externalUrlObjectBase);',
          '  externalUrlFromObjectBase.searchParams.set("id", "sku-123");',
          '  const externalUrlWithQueryFromBase = new URL("/product?id=sku-123", externalBase);',
          '  const parenthesizedExternalUrl = new URL(("/product?id=sku-123"), externalBase);',
          '  const derivedExternalUrl = new URL(externalBase + "/details", window.location.href);',
          '  derivedExternalUrl.searchParams.set("id", "sku-123");',
          '  const templateExternalUrl = new URL(`${externalBase}/variant`, window.location.href);',
          '  templateExternalUrl.searchParams.set("id", "sku-123");',
          '  const callbackExternalUrl = ((callbackUrl) => (callbackUrl.searchParams.set("id", "sku-123"), callbackUrl.href))(new URL(externalBase));',
          '  const mutateExternal = (callbackUrl) => { callbackUrl.searchParams.set("id", "sku-123"); return callbackUrl.href; };',
          '  const helperCallbackExternalUrl = mutateExternal(new URL(externalBase));',
          '  const helper = { mutate(callbackUrl) { callbackUrl.searchParams.set("id", "sku-123"); return callbackUrl.href; } };',
          '  const arrowHelper = { mutate: (callbackUrl) => { callbackUrl.searchParams.set("id", "sku-123"); return callbackUrl.href; } };',
          '  function mutate(callbackUrl) { callbackUrl.searchParams.set("id", "sku-123"); return callbackUrl.href; }',
          '  const boundMutateExternal = mutate.bind(null);',
          '  const objectCallbackExternalUrl = helper.mutate(new URL(externalBase));',
          '  const arrowObjectCallbackExternalUrl = arrowHelper.mutate(new URL(externalBase));',
          '  const boundCallbackExternalUrl = boundMutateExternal(new URL(externalBase));',
          '  function mutateSecondArg(ctx, callbackUrl) { callbackUrl.searchParams.set("id", "sku-123"); return callbackUrl.href; }',
          '  const boundSecondArgExternal = mutateSecondArg.bind(null, "ctx");',
          '  const secondArgExternalUrl = mutateSecondArg("ctx", new URL(externalBase));',
          '  const boundSecondArgExternalUrl = boundSecondArgExternal(new URL(externalBase));',
          '  const relativeConcatUrl = new URL("?id=" + "sku-123", externalBase);',
          '  function localHelper() { const endpoint = "local"; return endpoint; }',
          '  return { productUrl, objectUrl: "https://example.test/product?" + productParams, inlineObjectUrl: "https://example.test/product?" + new URLSearchParams({ id: "sku-123" }), inlineTemplateUrl: `https://example.test/product?${new URLSearchParams({ id: "sku-123" })}`, aliasInlineTemplateUrl: `${externalBase}?${new URLSearchParams({ id: "sku-123" })}`, stringUrl: "https://example.test/product?" + stringParams, aliasStringUrl: externalBase + "?" + stringParams, grid: "https://example.test/layout?" + layoutParams, splitInlineExternal, splitLiteralExternal, splitUrl: externalBase + "?" + "id=" + "sku-123", splitKeyUrl: externalBase + "?" + "id" + "=" + "sku-123", aliasSplitUrl: externalBase + "?" + externalRouteKey + "=" + "sku-123", aliasTemplateUrl: `${externalBase}?${externalRouteKey}=sku-123`, url: url.href, externalUrl: externalUrl.href, externalAliasUrl: externalAliasUrl.href, externalBracketUrl: externalBracketUrl.href, externalOptionalCallUrl: externalOptionalCallUrl.href, externalUrlWithBase: externalUrlWithBase.href, externalUrlFromBase: externalUrlFromBase.href, externalUrlFromPathAlias: externalUrlFromPathAlias.href, externalUrlFromObjectBase: externalUrlFromObjectBase.href, externalUrlWithQueryFromBase: externalUrlWithQueryFromBase.href, parenthesizedExternalUrl: parenthesizedExternalUrl.href, derivedExternalUrl: derivedExternalUrl.href, templateExternalUrl: templateExternalUrl.href, callbackExternalUrl, helperCallbackExternalUrl, objectCallbackExternalUrl, arrowObjectCallbackExternalUrl, boundCallbackExternalUrl, secondArgExternalUrl, boundSecondArgExternalUrl, relativeConcatUrl: relativeConcatUrl.href };',
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
      'modules/barrel.js',
      'modules/config.js',
      'modules/external-factory.js',
      'modules/external-factory-fake-declaration.js',
      'modules/external-factory-fake-declaration-user.js',
      'modules/external-factory-nested-var.js',
      'modules/external-factory-nested-var-user.js',
      'modules/external-factory-nested-imported-name.js',
      'modules/external-factory-nested-imported-name-user.js',
      'modules/external-factory-sibling-shadow.js',
      'modules/external-factory-sibling-shadow-user.js',
      'modules/external-factory-user.js',
      'modules/imported.js',
      'modules/local-export-barrel.js',
      'modules/layout.js',
      'modules/star-barrel.js',
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

test('verifyCatalog avoids v4 helper-mutation false positives across scopes', async () => {
  await assertV4PackagedSourceAccepted(
    'export function setup() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } } export function route() { function mutate(url) { return url.href; } return mutate(new URL(location.href)); }'
  );
});

test('verifyCatalog avoids v4 helper-mutation false positives across nested shadows', async () => {
  await assertV4PackagedSourceAccepted(
    'export function route(ok) { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } }; if (ok) { function mutate(url) { return url.href; } const helper = { mutate(url) { return url.href; } }; return { direct: mutate(new URL(location.href)), member: helper.mutate(new URL(location.href)) }; } return null; }'
  );
});

test('verifyCatalog avoids v4 simple helper false positives on object methods', async () => {
  await assertV4PackagedSourceAccepted(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { mutate(url) { return url.href; } }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceAccepted(
    'export function route() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { mutate(url) { return url.href; } }; return helper . mutate(new URL(location.href)) || helper ?. mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceAccepted(
    'function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } export function route() { function mutate(url) { return url.href; } const helper = { mutate }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceAccepted(
    'export function route() { const helper = { routes: { mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } }, mutate(url) { return url.href; } }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route() { const helper = { marker: /{/, routes: { mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } } }; return helper.routes.mutate(new URL(location.href)); }'
  );
});

test('verifyCatalog allows external URL object member aliases', async () => {
  await assertV4PackagedSourceAccepted(
    'export function route(sku) { const endpoints = { product: "https://api.example.test/product" }; const url = new URL(endpoints.product); url.searchParams.set("id", sku); return url.href; }'
  );
});

test('verifyCatalog rejects v4 returned route URL factories and default object helpers', async () => {
  await assertV4PackagedSourceRejected(
    'export function route(post) { function makeUrl() { const url = new URL(location.href); return url; } makeUrl().searchParams.set("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'export async function route(post) { async function makeUrl() { return new URL(location.href); } const url = await makeUrl(); url.searchParams.set("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function route(post) { makeUrl().searchParams.set("id", post.location); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { const url = new URL(location.href); return url; }\n' }
  );
  await assertV4PackagedSourceRejected(
    'export default { makeUrl() { return new URL(location.href); }, mount(post) { this.makeUrl().searchParams.set("id", post.location); } };'
  );
  await assertV4PackagedSourceRejected(
    'const theme = { makeUrl() { return new URL(location.href); }, mount(post) { this.makeUrl().searchParams.set("id", post.location); }, views: {}, components: {}, effects: {} }; export default theme;'
  );
  await assertV4PackagedSourceRejected(
    'const theme = { makeUrl() { return new URL(location.href); }, mount(post) { this.makeUrl().searchParams.set("id", post.location); }, views: {}, components: {}, effects: {} }; export { theme as default };'
  );
});

test('verifyCatalog rejects v4 computed route URL property access', async () => {
  await assertV4PackagedSourceRejected(
    'export function route(post) { const url = new URL(location.href); url["search" + "Params"].set("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { function makeUrl() { return new URL(location.href); } makeUrl()["search" + "Params"].set("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { const url = new URL(location.href); url.searchParams["se" + "t"]("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { const method = "set"; const url = new URL(location.href); url.searchParams[method]("id", post.location); }'
  );
  await assertV4PackagedSourceRejected(
    'export function route(post) { location["se" + "arch"] = "id=" + post.location; }'
  );
});

test('verifyCatalog avoids imported route-key alias shadow false positives', async () => {
  await assertV4PackagedSourceAccepted(
    'import { key } from "./config.js"; export function route(post) { const key = "sku"; const url = new URL(location.href); url.searchParams.set(key, post.location); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const key = "id";\n' }
  );
  await assertV4PackagedSourceAccepted(
    'import { key } from "./config.js"; export function route(key, post) { const url = new URL(location.href); url.searchParams.set(key, post.location); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const key = "id";\n' }
  );
});

test('verifyCatalog avoids semicolonless expression-arrow shadow false positives', async () => {
  await assertV4PackagedSourceAccepted(
    'import { endpoint } from "./config.js"; const helper = endpoint => endpoint\nexport function route() { const url = new URL(endpoint); url.searchParams.set("id", sku); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog keeps imported endpoint aliases available after nested same-name helpers', async () => {
  await assertV4PackagedSourceAccepted(
    'import { endpoint } from "./config.js"; function preview(endpoint) { return new URL(endpoint).href; } export function route() { const url = new URL(endpoint); url.searchParams.set("id", sku); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog rejects active nested same-name route factories', async () => {
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function mount() { function setup(post) { function makeProductUrl() { return new URL(location.href); } makeProductUrl().searchParams.set("id", post.id); } return setup; }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeProductUrl() { return new URL("/product", "https://api.example.test"); }\n' }
  );
});

test('verifyCatalog avoids nested route factory sibling leakage', async () => {
  await assertV4PackagedSourceAccepted(
    'export function mount() { function setup() { function makeUrl() { return new URL(location.href); } void makeUrl; } function route() { const makeUrl = () => new URL("https://api.example.test/product"); const url = makeUrl(); url.searchParams.set("id", sku); return url.href; } return { setup, route }; }'
  );
});

test('verifyCatalog rejects scoped route factory member assignment', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } state.url = makeUrl(); state.url.searchParams.set("id", post.id); return state.url.href; }'
  );
});

test('verifyCatalog avoids descendant same-name route factory false positives', async () => {
  await assertV4PackagedSourceAccepted(
    'export function mount() { function makeUrl() { return new URL(location.href); } function inner() { function makeUrl() { return new URL("https://api.example.test/product"); } const url = makeUrl(); url.searchParams.set("id", sku); return url.href; } return inner; }'
  );
  await assertV4PackagedSourceAccepted(
    'export function mount() { function makeUrl() { return new URL(location.href); } function inner() { function makeUrl() { return new URL("https://api.example.test/product"); } makeUrl().search = "id=" + sku; } return inner; }'
  );
});

test('verifyCatalog rejects single-param block arrow route factories', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const makeUrl = base => { return new URL(location.href); }; makeUrl(location.href).searchParams.set("id", post.id); }'
  );
});

test('verifyCatalog rejects var-hoisted scoped route factory shadows', async () => {
  await assertV4PackagedSourceRejected(
    'import { makeProductUrl } from "./url.js"; export function mount(post) { if (post) { var makeProductUrl = () => new URL(location.href); } makeProductUrl().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeProductUrl() { return new URL("/product", "https://api.example.test"); }\n' }
  );
});

test('verifyCatalog rejects scoped route factory nested call args', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl(base) { return new URL(location.href); } makeUrl(getBase()).searchParams.set("id", post.id); }'
  );
});

test('verifyCatalog rejects scoped route factory searchParams aliases', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const params = makeUrl().searchParams; params.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const params = (makeUrl()).searchParams; params.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const { searchParams } = (makeUrl()); searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const { ["searchParams"]: params } = makeUrl(); params.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const url = makeUrl(); const { searchParams = new URLSearchParams() } = url; searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const { searchParams = new URLSearchParams() } = makeUrl(); searchParams.set("id", post.id); }'
  );
});

test('verifyCatalog rejects scoped route factory searchParams dispatch', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } makeUrl().searchParams.set.call(makeUrl().searchParams, "id", post.id); makeUrl().searchParams.set.apply(makeUrl().searchParams, ["tab", "posts"]); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } makeUrl().searchParams.set.call(getTarget(a, b), "id", post.id); makeUrl().searchParams.set.apply(getTarget(a, b), ["tab", "posts"]); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } makeUrl().searchParams.set?.call(getTarget(a, b), "id", post.id); makeUrl().searchParams.set?.apply(getTarget(a, b), ["tab", "posts"]); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } (makeUrl)().searchParams.set("id", post.id); ((makeUrl))().search = "tab=posts"; }'
  );
});

test('verifyCatalog rejects inline new URL searchParams dispatch with comma receivers', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { new URL(location.href).searchParams.set.call(getTarget(a, b), "id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); url.searchParams.set.call(getTarget(a, b), "id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); url.searchParams.set["call"](url.searchParams, "id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { new URL(location.href).searchParams.set?.call(getTarget(a, b), "id", post.id); }'
  );
});

test('verifyCatalog rejects scoped route factory bracket member assignments', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } state["url"] = makeUrl(); state["url"].searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { state["url"] = new URL(location.href); state["url"].searchParams.set("id", post.id); }'
  );
});

test('verifyCatalog rejects imported route factory parenthesized callees', async () => {
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { (makeUrl)().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { const routeFactory = makeUrl; routeFactory().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { helper.routeFactory = makeUrl; helper.routeFactory().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { const helper = { makeUrl }; helper.makeUrl().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { const helper = { "routeFactory": makeUrl }; helper.routeFactory().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { const helper = { makeUrl }; const { makeUrl: routeFactory } = helper; routeFactory().searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { makeUrl } from "./url.js"; export function mount(post) { state["url"] = makeUrl(); state["url"].searchParams.set("id", post.id); }',
    'modules/interactions.js',
    { 'modules/url.js': 'export function makeUrl() { return new URL(location.href); }\n' }
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } makeUrl.call(null).searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { function makeUrl() { return new URL(location.href); } const url = makeUrl.apply(null, []); url.searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const helper = { makeUrl() { return new URL(location.href); } }; helper.makeUrl().searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const helper = { "makeUrl"() { return new URL(location.href); } }; helper.makeUrl().searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const helper = { ["makeUrl"]() { return new URL(location.href); } }; helper.makeUrl().searchParams.set("id", post.id); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const helper = { makeUrl() { return new URL(location.href); } }; const key = "makeUrl"; helper[key]().searchParams.set("id", post.id); }'
  );
});

test('verifyCatalog rejects destructured URL.searchParams mutator aliases', async () => {
  await assertV4PackagedSourceRejected(
    'export function mount() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { mutate }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount() { function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { "routeMutator": mutate }; return helper.routeMutator(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); const { ["searchParams"]: params } = url; params.set("id", post.id); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const { ["searchParams"]: params } = new URL(location.href); params.set("id", post.id); return "?" + params; }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); const { set } = url.searchParams; set.call(url.searchParams, "id", post.id); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); const { set } = url.searchParams; set["call"](getTarget(a, b), "id", post.id); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount(post) { const url = new URL(location.href); const { ["append"]: appendParam } = url.searchParams; appendParam("tab", "posts"); return url.href; }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount() { const helper = { "mutate": (url) => { url.searchParams.set("id", "post.md"); return url.href; } }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount() { const helper = { ["mutate"](url) { url.searchParams.set("id", "post.md"); return url.href; } }; return helper.mutate(new URL(location.href)); }'
  );
  await assertV4PackagedSourceRejected(
    'export function mount() { const helper = { mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } }; const key = "mutate"; return helper[key](new URL(location.href)); }'
  );
});

test('verifyCatalog avoids same-name object method route factory false positives', async () => {
  await assertV4PackagedSourceAccepted(
    'export function mount() { function makeUrl() { return new URL(location.href); } const helper = { makeUrl() { return new URL("https://api.example.test/product"); } }; helper.makeUrl().searchParams.set("id", sku); }'
  );
  await assertV4PackagedSourceAccepted(
    'export function mount() { function makeUrl() { return new URL(location.href); } const helper = { makeUrl() { return new URL("https://api.example.test/product"); } }; helper . makeUrl().searchParams.set("id", sku); helper ?. makeUrl().searchParams.set("tab", "posts"); }'
  );
  await assertV4PackagedSourceAccepted(
    'function makeUrl() { return new URL(location.href); } export function mount() { function makeUrl() { return new URL("https://api.example.test/product"); } const routeFactory = makeUrl; routeFactory().searchParams.set("id", sku); }'
  );
  await assertV4PackagedSourceAccepted(
    'function makeUrl() { return new URL(location.href); } export function mount() { function makeUrl() { return new URL("https://api.example.test/product"); } const helper = {}; helper.routeFactory = makeUrl; helper.routeFactory().searchParams.set("id", sku); }'
  );
  await assertV4PackagedSourceAccepted(
    'function makeUrl() { return new URL(location.href); } const helper = {}; const marker = "helper.routeFactory = makeUrl"; helper.routeFactory = () => new URL("https://api.example.test/product"); export function mount() { helper.routeFactory().searchParams.set("id", sku); }'
  );
  await assertV4PackagedSourceAccepted(
    'function mutate(url) { url.searchParams.set("id", "post.md"); return url.href; } const helper = { mutate }; export function mount() { const helper = { mutate: (url) => url.href }; const { mutate: routeMutator } = helper; return routeMutator(new URL(location.href)); }'
  );
});

test('verifyCatalog rejects block-scoped imported endpoint shadows that build public routes', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(ok) { try { const endpoint = location.href; const url = new URL(endpoint); url.searchParams.set("id", sku); return url.href; } finally {} }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog rejects local endpoint aliases shadowed by route builders', async () => {
  await assertV4PackagedSourceRejected(
    'const endpoint = "https://api.example.test/product"; export function route(endpoint, post) { return endpoint + "?id=" + post.id; }'
  );
});

test('verifyCatalog rejects catch-bound imported endpoint shadows that build public routes', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route() { try { throw location.href; } catch (endpoint) { const url = new URL(endpoint); url.searchParams.set("id", sku); return url.href; } }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog rejects shadowing masked by nested external helpers', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(endpoint, post) { function helper() { const endpoint = "https://api.example.test/product"; return endpoint; } const url = new URL(endpoint); url.searchParams.set("id", post.location); return helper() || url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog rejects destructured external endpoint shadows', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route([endpoint], post) { const url = new URL(endpoint); url.searchParams.set("id", post.location); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(post) { const [endpoint] = [location.href]; const url = new URL(endpoint); url.searchParams.set("id", post.location); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route({ endpoint: endpoint = location.href }, post) { const url = new URL(endpoint); url.searchParams.set("id", post.location); return url.href; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog rejects loop-bound external endpoint shadows', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route() { for (const endpoint of [location.href]) { const url = new URL(endpoint); url.searchParams.set("id", post.location); return url.href; } }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog keeps string braces from truncating shadowed body scans', async () => {
  await assertV4PackagedSourceRejected(
    'import { endpoint } from "./config.js"; export function route(endpoint, post) { const marker = "}"; return endpoint + "?id=" + post.id; }',
    'modules/interactions.js',
    { 'modules/config.js': 'export const endpoint = "https://api.example.test/product";\n' }
  );
});

test('verifyCatalog does not treat slashes in regex literals as comments', async () => {
  await assertV4PackagedSourceRejected(
    'export function route() { const re = /^https?:\\/\\//; return "?id=post.md"; }'
  );
});

test('verify catalog workflow pins the transition Press version', async () => {
  const workflow = await readFile(new URL('../.github/workflows/verify-catalog.yml', import.meta.url), 'utf8');
  assert.match(workflow, /verify-catalog\.mjs[^\n]*--press-version 3\.4\.130/u);
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
    release.files = Array.from(new Set([
      ...Object.keys(extraFiles),
      file,
      'modules/layout.js',
      'theme.css',
      'theme.json'
    ])).sort();
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

async function assertV4PackagedSourceAccepted(source, file = 'modules/interactions.js', extraFiles = {}) {
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
    release.files = Array.from(new Set([
      ...Object.keys(extraFiles),
      file,
      'modules/layout.js',
      'theme.css',
      'theme.json'
    ])).sort();
    await writeJson(releasePath, release);

    const result = await verifyCatalog({
      catalogPath,
      workspaceRoot,
      remote: false,
      verifyAssets: true,
      pressVersion: '3.4.130'
    });

    assert.equal(result.ok, true, result.failures.join('\n'));
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
