import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Task } from '../src/task.mjs';

const capability = (access, execute = async () => 'ok', validate = () => true) => ({ access, execute, validate });

test('default requires one-time approval bound to frozen parameters', async () => {
  const seen = [];
  const task = new Task({ capabilities: { save: capability('rollback-write', async args => seen.push(args)) } });
  const args = { path: 'report.md', content: { text: 'original' } };
  const approval = await task.request('save', args);
  args.content.text = 'changed';
  assert.equal(seen.length, 0);
  await assert.rejects(task.approve('other-ticket'));
  await task.approve(approval.ticket);
  assert.equal(seen[0].content.text, 'original');
  assert.equal(Object.isFrozen(seen[0].content), true);
  await assert.rejects(task.approve(approval.ticket));
  assert.equal(seen.length, 1);
  assert.equal((await task.request('save', args)).kind, 'approval');
});

test('auto mode only permits read and registered rollback writes', async () => {
  for (const access of ['read', 'rollback-write', 'command', 'external', 'destructive']) {
    let calls = 0;
    const task = new Task({ permission: 'workspace-auto', capabilities: { tool: capability(access, async () => ++calls) } });
    const result = await task.request('tool');
    const auto = ['read', 'rollback-write'].includes(access);
    assert.equal(result.kind, auto ? 'result' : 'approval');
    assert.equal(calls, auto ? 1 : 0);
  }
});

test('plan remains read only until host confirms it', async () => {
  const task = new Task({ execution: 'plan', permission: 'workspace-auto', capabilities: {
    read: capability('read'), save: capability('rollback-write'),
  } });
  await task.request('read');
  assert.equal(task.snapshot().state, 'planning');
  await assert.rejects(task.request('save'));
  assert.throws(() => task.complete());
  task.confirmPlan();
  await task.request('save');
  task.complete();
  await assert.rejects(task.request('read'));
});

test('validation denies both initial requests and approvals after authority changes', async () => {
  let authorized = true;
  let executions = 0;
  const task = new Task({ capabilities: {
    save: capability('rollback-write', async () => ++executions, () => authorized),
  } });
  await assert.rejects(task.request('unknown'));
  const { ticket } = await task.request('save');
  authorized = false;
  await assert.rejects(task.approve(ticket));
  assert.equal(executions, 0);
  assert.equal(task.snapshot().state, 'failed');
  const denied = new Task({ capabilities: { read: capability('read', undefined, () => false) } });
  await assert.rejects(denied.request('read'));
  const ambiguous = new Task({ capabilities: { read: capability('read', undefined, async () => true) } });
  await assert.rejects(ambiguous.request('read'));
});

test('reject and cancel invalidate tickets without performing the action', async () => {
  let calls = 0;
  const task = new Task({ capabilities: { send: capability('external', async () => ++calls) } });
  const first = await task.request('send');
  await assert.rejects(task.request('send'));
  task.reject(first.ticket);
  await assert.rejects(task.approve(first.ticket));
  const second = await task.request('send');
  task.cancel();
  await assert.rejects(task.approve(second.ticket));
  assert.equal(calls, 0);
});

test('cancellation signals executor and suppresses late success', async () => {
  let finish;
  let receivedSignal;
  const task = new Task({ capabilities: { read: capability('read', async (_args, { signal }) => {
    receivedSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  }) } });
  const execution = task.request('read');
  await assert.rejects(task.request('read'));
  assert.throws(() => task.complete());
  task.cancel();
  assert.equal(receivedSignal.aborted, true);
  finish('late response');
  assert.equal((await execution).kind, 'cancelled');
  assert.equal(task.snapshot().state, 'cancelled');
  assert.equal(task.snapshot().events.some(event => event.type === 'succeeded'), false);
});

test('failure is terminal and event snapshots cannot mutate internal records', async () => {
  const task = new Task({ capabilities: { read: capability('read', async () => { throw new Error('offline'); }) } });
  await assert.rejects(task.request('read'), /offline/);
  await assert.rejects(task.request('read'));
  const snapshot = task.snapshot();
  snapshot.events[0].type = 'tampered';
  assert.equal(task.snapshot().events[0].type, 'created');
  assert.deepEqual(snapshot.events.map(event => event.sequence), [1, 2, 3, 4]);
});

test('risk registration cannot be changed by caller after construction', async () => {
  const send = capability('external');
  const task = new Task({ permission: 'workspace-auto', capabilities: { send } });
  send.access = 'read';
  assert.equal((await task.request('send')).kind, 'approval');
  assert.throws(() => new Task({ permission: 'anything' }));
  assert.throws(() => new Task({ capabilities: { bad: { access: 'read' } } }));
});

test('non-JSON and cyclic parameters fail without executing', async () => {
  const task = new Task({ capabilities: { read: capability('read') } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const params of [cyclic, { n: Infinity }, { fn() {} }, new Date(), { value: undefined }]) {
    await assert.rejects(task.request('read', params));
  }
  assert.equal(task.snapshot().state, 'ready');
});
