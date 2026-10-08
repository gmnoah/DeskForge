import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// Mock Electron utilityProcess
const mockUtilityProcessInstance = new EventEmitter() as any
mockUtilityProcessInstance.postMessage = vi.fn()
mockUtilityProcessInstance.kill = vi.fn()
mockUtilityProcessInstance.stderr = new EventEmitter()

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => mockUtilityProcessInstance),
  },
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}))

import { WORKER_PROTOCOL_VERSION } from '@deskforge/contracts'
import { ToolRunnerBridge } from './worker-bridge'

describe('ToolRunnerBridge', () => {
  it('times out and sends cancel when tool execution takes longer than timeoutMs', async () => {
    const bridge = new ToolRunnerBridge()

    const executePromise = bridge.execute({
      type: 'execute',
      action: 'shell.run',
      args: { command: 'sleep 10' },
      timeoutMs: 50,
    })

    await expect(executePromise).rejects.toMatchObject({
      code: 'TOOL_TIMEOUT',
      message: expect.stringContaining('工具执行超时'),
    })

    expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancel' }),
    )
  })

  it('keeps cancelled requests pending until the runner reports the outcome', async () => {
    const bridge = new ToolRunnerBridge()
    const single = bridge.execute({ requestId: 'cancel-one', runId: 'run-a', toolId: 'shell.run', args: { command: 'sleep 10' } })
    const runScoped = bridge.execute({ requestId: 'cancel-run', runId: 'run-b', toolId: 'shell.run', args: { command: 'sleep 10' } })

    bridge.cancel('cancel-one')
    bridge.cancelRun('run-b')
    for (const requestId of ['cancel-one', 'cancel-run']) {
      mockUtilityProcessInstance.emit('message', { protocolVersion: WORKER_PROTOCOL_VERSION, type: 'result', requestId, ok: false, error: '命令已取消' })
    }

    await expect(single).rejects.toThrow('命令已取消')
    await expect(runScoped).rejects.toThrow('命令已取消')
  })

  it('rejects all pending executions when stop() is called', async () => {
    const bridge = new ToolRunnerBridge()

    const p1 = bridge.execute({ type: 'execute', action: 'shell.run', args: { command: 'long 1' }, timeoutMs: 10_000 })
    const p2 = bridge.execute({ type: 'execute', action: 'shell.run', args: { command: 'long 2' }, timeoutMs: 10_000 })

    bridge.stop()

    await expect(p1).rejects.toThrow('Tool Runner 已停止')
    await expect(p2).rejects.toThrow('Tool Runner 已停止')
  })
})
