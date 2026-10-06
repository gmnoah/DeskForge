import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  symlinkSync, linkSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { Workspace } from '../src/workspace.mjs';
import { Task } from '../src/task.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'deskforge-workspace-'));
  const root = join(base, 'project'); const history = join(base, 'history');
  mkdirSync(root); mkdirSync(history, { mode: 0o700 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, history, workspace: new Workspace({ root, historyDirectory: history }) };
}

test('registration rejects root, home, symlink and public or overlapping history', t => {
  const { base, root, history } = fixture(t);
  const make = (selected, archive = history) => new Workspace({ root: selected, historyDirectory: archive });
  assert.throws(() => make(parse(root).root)); assert.throws(() => make(homedir()));
  symlinkSync(root, join(base, 'alias')); assert.throws(() => make(join(base, 'alias')));
  assert.throws(() => make(root, root)); chmodSync(history, 0o755); assert.throws(() => make(root));
});

test('read returns version and lines; blocks traversal, sensitive files and links', t => {
  const { root, base, workspace } = fixture(t);
  writeFileSync(join(root, 'notes.md'), '第一行\n第二行');
  const result = workspace.read('notes.md');
  assert.equal(result.lines, 2); assert.equal(result.text, '第一行\n第二行'); assert.equal(result.path, 'notes.md');
  writeFileSync(join(base, 'outside.txt'), 'secret');
  symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt')); symlinkSync(base, join(root, 'alias'));
  for (const path of ['../outside.txt', join(base, 'outside.txt'), 'alias/outside.txt', 'link.txt', './notes.md', 'sub/../notes.md']) assert.throws(() => workspace.read(path));
  for (const path of ['.env', '.env.local', 'private.key', 'credentials.json', '.npmrc']) {
    writeFileSync(join(root, path), 'secret');
    assert.throws(() => workspace.read(path)); assert.throws(() => workspace.prepareWrite(path, 'new'));
  }
  linkSync(join(root, 'notes.md'), join(root, 'hardlink.md')); assert.throws(() => workspace.read('hardlink.md'));
});

test('file limits, binary and non-UTF8 text are denied', t => {
  const { root, workspace } = fixture(t);
  for (const [name, bytes] of [['large', Buffer.alloc(1024 * 1024 + 1, 65)], ['binary', Buffer.from([1, 0, 3])], ['bad', Buffer.from([0xff])]]) {
    writeFileSync(join(root, name), bytes); assert.throws(() => workspace.read(name));
  }
  assert.throws(() => workspace.prepareWrite('too-big', 'a'.repeat(1024 * 1024 + 1)));
  assert.throws(() => workspace.prepareWrite('nul', 'a\0b'));
});

test('write preview has no side effects; task approval creates file and durable rollback', async t => {
  const { root, history, workspace } = fixture(t);
  const task = new Task({ permission: 'workspace-auto', capabilities: workspace.capabilities() });
  const preview = (await task.request('write_preview', { path: 'report.md', text: 'summary' })).value;
  assert.equal(preview.beforeLines, 0); assert.equal(preview.after, 'summary');
  assert.equal(existsSync(join(root, 'report.md')), false); assert.deepEqual(readdirSync(history), []);
  const approval = await task.request('write_text', { previewId: preview.id });
  assert.equal(approval.kind, 'approval'); assert.equal(existsSync(join(root, 'report.md')), false);
  const write = (await task.approve(approval.ticket)).value;
  assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), 'summary');
  assert.throws(() => workspace.commitWrite(preview.id));
  const fresh = new Workspace({ root, historyDirectory: history });
  const rollbackTask = new Task({ capabilities: fresh.capabilities() });
  const rollbackApproval = await rollbackTask.request('rollback_write', { historyId: write.historyId });
  assert.equal(rollbackApproval.kind, 'approval'); await rollbackTask.approve(rollbackApproval.ticket);
  assert.equal(existsSync(join(root, 'report.md')), false); assert.throws(() => fresh.rollback(write.historyId));
});

test('approval fails if file changed or replaced after preview', async t => {
  const { root, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'before');
  const preview = workspace.prepareWrite('a.txt', 'after');
  const task = new Task({ capabilities: workspace.capabilities() });
  const approval = await task.request('write_text', { previewId: preview.id });
  writeFileSync(join(root, 'a.txt'), 'other edit'); await assert.rejects(task.approve(approval.ticket));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'other edit');
  const same = workspace.prepareWrite('a.txt', 'after');
  renameSync(join(root, 'a.txt'), join(root, 'old.txt')); writeFileSync(join(root, 'a.txt'), 'other edit');
  assert.throws(() => workspace.commitWrite(same.id));
});

test('rollback restores old content but refuses concurrent edits and unsafe history', t => {
  const { root, history, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'original');
  const committed = workspace.commitWrite(workspace.prepareWrite('a.txt', 'new').id);
  workspace.rollback(committed.historyId); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original');
  const second = workspace.commitWrite(workspace.prepareWrite('a.txt', 'second').id);
  writeFileSync(join(root, 'a.txt'), 'human edit');
  assert.throws(() => workspace.rollback(second.historyId), /conflict/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'human edit'); assert.throws(() => workspace.rollback('../a.txt'));
  const historyFile = join(history, `${second.historyId}.json`);
  rmSync(historyFile); symlinkSync(join(root, 'a.txt'), historyFile); assert.throws(() => workspace.rollback(second.historyId));
});

test('revocation invalidates outstanding approvals', async t => {
  const { root, workspace } = fixture(t);
  const preview = workspace.prepareWrite('a.txt', 'data');
  const task = new Task({ capabilities: workspace.capabilities() });
  const approval = await task.request('write_text', { previewId: preview.id }); workspace.revoke();
  await assert.rejects(task.approve(approval.ticket)); assert.equal(existsSync(join(root, 'a.txt')), false);
  assert.throws(() => workspace.read('a.txt'));
});

test('replaced parent symlink never writes through to outside directory', async t => {
  const { root, base, workspace } = fixture(t);
  mkdirSync(join(root, 'sub')); mkdirSync(join(base, 'outside'));
  const preview = workspace.prepareWrite('sub/a.txt', 'data');
  const task = new Task({ capabilities: workspace.capabilities() });
  const approval = await task.request('write_text', { previewId: preview.id });
  renameSync(join(root, 'sub'), join(root, 'sub-old')); symlinkSync(join(base, 'outside'), join(root, 'sub'));
  await assert.rejects(task.approve(approval.ticket)); assert.equal(existsSync(join(base, 'outside/a.txt')), false);
});

test('changed root or history directories invalidate authorization', t => {
  const { root, history, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'a'); renameSync(root, `${root}-old`); mkdirSync(root);
  assert.throws(() => workspace.read('a.txt'), /changed/);
  const second = new Workspace({ root, historyDirectory: history });
  renameSync(history, `${history}-old`); mkdirSync(history, { mode: 0o700 });
  assert.throws(() => second.prepareWrite('a.txt', 'b'), /changed/);
});

test('aborted commit preserves target and does not create history', t => {
  const { root, history, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'before'); const preview = workspace.prepareWrite('a.txt', 'after');
  const controller = new AbortController(); controller.abort();
  assert.throws(() => workspace.commitWrite(preview.id, { signal: controller.signal }));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'before'); assert.deepEqual(readdirSync(history), []);
});

test('search respects root and nested ignore rules, returns cited lines and skips unsafe text', t => {
  const { root, base, workspace } = fixture(t);
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'ignored'));
  writeFileSync(join(root, '.gitignore'), 'ignored/\n*.log\n!keep.log\n');
  writeFileSync(join(root, 'docs/.gitignore'), 'private.md\n');
  for (const [path, text] of [['docs/a.md', 'line one\nNeedle'], ['docs/private.md', 'needle'],
    ['ignored/a.md', 'needle'], ['a.log', 'needle'], ['keep.log', 'needle'], ['.env', 'needle']]) writeFileSync(join(root, path), text);
  writeFileSync(join(root, 'binary'), Buffer.from([0, 5])); symlinkSync(base, join(root, 'escape'));
  const found = workspace.search({ query: 'NEEDLE' });
  assert.deepEqual(found.results.map(item => [item.path, item.line]), [['docs/a.md', 2], ['keep.log', 1]]);
  assert.equal(found.truncated, false);
  assert.deepEqual(workspace.search({ pattern: 'docs/**/*.md' }).results.map(item => item.path), ['docs/a.md']);
  assert.equal(workspace.search({ limit: 1 }).truncated, true); assert.equal(workspace.search({ maxEntries: 1 }).truncated, true);
  assert.throws(() => workspace.search({ limit: 1001 })); assert.throws(() => workspace.search({ pattern: '[a]' }));
});

test('unsupported ignore syntax fails explicitly rather than indexing ignored content', t => {
  const { root, workspace } = fixture(t);
  writeFileSync(join(root, '.gitignore'), '[ab].txt'); writeFileSync(join(root, 'a.txt'), 'data');
  assert.throws(() => workspace.search(), /Unsupported glob/);
});

test('preview changes and discarded previews remain bounded', t => {
  const { root, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'unchanged\nold\nend');
  const preview = workspace.prepareWrite('a.txt', 'unchanged\nnew\nend');
  assert.deepEqual(preview.changes.lines, [
    { kind: 'remove', line: 2, text: 'old' }, { kind: 'add', line: 2, text: 'new' },
  ]);
  workspace.discardPreview(preview.id);
  assert.equal(workspace.validateWrite(preview.id), false);
  const long = workspace.prepareWrite('long.txt', Array.from({ length: 500 }, () => 'line').join('\n'));
  assert.equal(long.changes.truncated, true);
  assert.equal(long.changes.lines.length, 200);
});

test('backup corruption prevents rollback without changing the target', t => {
  const { root, history, workspace } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'original');
  const committed = workspace.commitWrite(workspace.prepareWrite('a.txt', 'new').id);
  const file = join(history, `${committed.historyId}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.before = Buffer.from('corrupted').toString('base64');
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => workspace.rollback(committed.historyId), /Backup content invalid/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'new');
});
