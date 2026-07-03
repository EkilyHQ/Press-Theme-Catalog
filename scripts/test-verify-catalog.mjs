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
        'modules/interactions.js': 'export function route() { const url = new URL(location.href); url.searchParams.set("id", "post.md"); return url.href; }\n'
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

test('verifyCatalog allows v4 ZIP packaged source with external query strings', async () => {
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
        'modules/layout.js': [
          'export function mount() {',
          '  const productUrl = "https://example.test/product?id=sku-123";',
          '  const routeKey = "tab";',
          '  const url = new URL("https://analytics.example.test/collect");',
          '  url.searchParams.set(routeKey, "posts");',
          '  url.searchParams.set("utm_source", "press-theme");',
          '  return { productUrl, url: url.href };',
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

    assert.equal(result.ok, true);
  });
});

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
