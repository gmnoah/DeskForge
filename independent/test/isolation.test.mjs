import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

async function modules(directory) {
  const paths = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) paths.push(...await modules(path));
    else if (item.name.endsWith('.mjs')) paths.push(path);
  }
  return paths;
}

test('new executable modules use only Node builtins or modules inside independent/', async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(packageJson.dependencies ?? {}).length, 0);
  for (const file of await modules(root)) {
    const source = await readFile(file, 'utf8');
    // Deliberately small static gate; source review remains required for computed loading and assets.
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, file);
    for (const match of source.matchAll(/\b(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.equal(specifier.startsWith('.'), true, `${file}: external import ${specifier}`);
      const target = resolve(dirname(file), specifier);
      const local = relative(root, target);
      assert.equal(local.startsWith('..'), false, `${file}: import escapes independent/`);
      await readFile(target);
    }
  }
});
