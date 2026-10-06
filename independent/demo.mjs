import { Task } from './src/task.mjs';

// In-memory demonstration only: no files, shell commands, model calls or network requests.
const documents = new Map([['notes.md', '完成了模型配置和工作区授权。']]);
const task = new Task({ capabilities: {
  read: { access: 'read', validate: args => documents.has(args.path), execute: async args => documents.get(args.path) },
  save: { access: 'rollback-write', validate: args => args.path === 'report.md' && typeof args.text === 'string',
    execute: async args => { documents.set(args.path, args.text); return args.path; } },
} });
const notes = await task.request('read', { path: 'notes.md' });
const approval = await task.request('save', { path: 'report.md', text: `工作摘要：${notes.value}` });
console.log('写入前：', documents.has('report.md'), '状态：', task.snapshot().state);
await task.approve(approval.ticket);
task.complete();
console.log('批准后：', documents.get('report.md'), '状态：', task.snapshot().state);
