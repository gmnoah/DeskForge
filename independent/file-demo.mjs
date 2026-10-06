import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from './src/workspace.mjs';
import { Task } from './src/task.mjs';

// Temporary example data only; do not use a real workspace for this demonstration.
const temporary = mkdtempSync(join(tmpdir(), 'deskforge-file-demo-'));
try {
  const root = join(temporary, 'project'); const history = join(temporary, 'history');
  mkdirSync(root); mkdirSync(history, { mode: 0o700 });
  writeFileSync(join(root, 'notes.md'), '本周完成模型设置。\n下周验证知识库。');
  const workspace = new Workspace({ root, historyDirectory: history });
  const task = new Task({ capabilities: workspace.capabilities() });
  const sources = (await task.request('search_text', { query: '本周' })).value;
  console.log('检索引用：', sources.results.map(item => `${item.path}:${item.line}`));
  const preview = (await task.request('write_preview', { path: 'notes.md', text: '本周完成模型设置和权限验证。\n下周验证知识库。' })).value;
  console.log('变更预览：', preview.changes);
  const approval = await task.request('write_text', { previewId: preview.id });
  console.log('批准前：', readFileSync(join(root, 'notes.md'), 'utf8'));
  const saved = (await task.approve(approval.ticket)).value;
  console.log('批准后：', readFileSync(join(root, 'notes.md'), 'utf8'));
  const undo = await task.request('rollback_write', { historyId: saved.historyId });
  await task.approve(undo.ticket);
  console.log('回滚后：', readFileSync(join(root, 'notes.md'), 'utf8'));
  task.complete();
} finally { rmSync(temporary, { recursive: true, force: true }); }
