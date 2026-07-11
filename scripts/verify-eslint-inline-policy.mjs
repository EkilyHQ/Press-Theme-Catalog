import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const eslint = new ESLint({ cwd: REPO_ROOT });

const [result] = await eslint.lintText('// eslint-disable-next-line no-undef\nmissingCatalogQualityGlobal();\n', {
  filePath: path.join(SCRIPT_DIR, 'inline-disable-regression.mjs')
});

assert.ok(result.errorCount > 0, 'an inline directive beside no-undef must still fail the lint gate');
assert.ok(
  result.messages.some((message) => message.ruleId === 'no-undef' && message.severity === 2),
  'noInlineConfig must leave the underlying no-undef error unsuppressed'
);
assert.equal(
  result.suppressedMessages.some((message) => message.ruleId === 'no-undef'),
  false,
  'the no-undef error must not move into ESLint suppressedMessages'
);

const [cleanResult] = await eslint.lintText('const catalogQualityValue = 1;\nvoid catalogQualityValue;\n', {
  filePath: path.join(SCRIPT_DIR, 'clean-regression.mjs')
});
assert.equal(cleanResult.errorCount, 0, 'ordinary zero-debt Catalog tooling must remain green');
assert.equal(cleanResult.warningCount, 0, 'ordinary zero-debt Catalog tooling must remain warning-free');

process.stdout.write('Catalog ESLint inline-policy regression passed.\n');
