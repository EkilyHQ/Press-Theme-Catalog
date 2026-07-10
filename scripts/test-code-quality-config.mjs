import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const EXPECTED_NODE_VERSION = '22.18.0';
const EXPECTED_DEV_DEPENDENCIES = {
  '@eslint/js': '10.0.1',
  eslint: '10.6.0',
  globals: '17.7.0',
  prettier: '3.9.4'
};

async function readText(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function listJavaScriptFiles(relativeDirectory = '') {
  const directory = path.join(ROOT, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
      files.push(...(await listJavaScriptFiles(relativePath)));
    } else if (/\.(?:cjs|js|mjs)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test('quality dependencies and commands are deterministic', async () => {
  const packageJson = await readJson('package.json');
  const lockfile = await readJson('package-lock.json');

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines.node, '>=22.18.0 <23');
  assert.deepEqual(packageJson.devDependencies, EXPECTED_DEV_DEPENDENCIES);
  assert.equal(packageJson.scripts.lint, 'eslint --max-warnings 0 .');
  assert.equal(packageJson.scripts['format:check'], 'prettier --check . --ignore-unknown');
  assert.equal(
    packageJson.scripts.quality,
    'node scripts/test-code-quality-config.mjs && npm run lint && npm run format:check'
  );
  assert.match(packageJson.scripts.test, /node scripts\/test-code-quality-config\.mjs/u);

  const rootPackage = lockfile.packages[''];
  assert.deepEqual(rootPackage.devDependencies, EXPECTED_DEV_DEPENDENCIES);
  for (const [name, version] of Object.entries(EXPECTED_DEV_DEPENDENCIES)) {
    assert.equal(lockfile.packages[`node_modules/${name}`].version, version);
  }
});

test('ESLint and Prettier cover all first-party scripts without baselines', async () => {
  const eslintConfig = await readText('eslint.config.mjs');
  const prettierConfig = await readJson('.prettierrc.json');
  const policy = await readJson('scripts/code-quality-policy.json');

  assert.match(eslintConfig, /eslint\.configs\.recommended/u);
  assert.match(eslintConfig, /files:\s*\['\*\*\/\*\.\{js,mjs,cjs\}'\]/u);
  assert.match(eslintConfig, /reportUnusedDisableDirectives:\s*'error'/u);
  assert.equal(policy.eslint.scope, '**/*.{js,mjs,cjs}');
  assert.equal(policy.eslint.maxWarnings, 0);
  assert.equal(policy.eslint.baselineViolations, 0);
  assert.deepEqual(policy.prettier.baselineExceptions, []);
  assert.equal(prettierConfig.singleQuote, true);
  assert.equal(prettierConfig.trailingComma, 'none');
});

test('type-checking decision is explicit and has a removal condition', async () => {
  const policy = await readJson('scripts/code-quality-policy.json');
  const productScripts = (await listJavaScriptFiles())
    .filter((file) => !['eslint.config.mjs', 'scripts/test-code-quality-config.mjs'].includes(file))
    .sort();

  assert.equal(policy.typeChecking.status, 'accepted-no-action');
  assert.deepEqual(policy.typeChecking.currentJavaScriptSurface, productScripts);
  assert.ok(Array.isArray(policy.typeChecking.evidence));
  assert.ok(policy.typeChecking.evidence.length >= 3);
  assert.match(policy.typeChecking.decision, /Do not introduce checkJs/u);
  assert.match(policy.typeChecking.revisitWhen, /supported external API|multiple reusable modules/u);
});

test('Code Quality runs read-only on the supported Node version', async () => {
  const workflow = await readText('.github/workflows/code-quality.yml');
  const verifyWorkflow = await readText('.github/workflows/verify-catalog.yml');
  const gitignore = await readText('.gitignore');
  const policy = await readJson('scripts/code-quality-policy.json');

  assert.equal(policy.nodeVersion, EXPECTED_NODE_VERSION);
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /schedule:\n\s+- cron: '[^']+'/u);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+packages: read/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /uses: actions\/setup-node@v6/u);
  assert.match(workflow, new RegExp(`node-version: '${EXPECTED_NODE_VERSION.replaceAll('.', '\\.')}'`, 'u'));
  assert.match(workflow, /run: npm ci --ignore-scripts/u);
  assert.match(workflow, /run: npm run quality/u);
  assert.match(workflow, /run: git diff --check/u);
  assert.match(workflow, /git status --porcelain=v1/u);
  assert.match(verifyWorkflow, /uses: actions\/setup-node@v6/u);
  assert.match(verifyWorkflow, new RegExp(`node-version: '${EXPECTED_NODE_VERSION.replaceAll('.', '\\.')}'`, 'u'));
  assert.match(verifyWorkflow, /run: npm ci --ignore-scripts/u);
  assert.match(gitignore, /^\/node_modules\/$/mu);
  assert.match(gitignore, /^\/dist\/$/mu);
});
