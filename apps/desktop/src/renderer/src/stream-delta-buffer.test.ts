import { describe, expect, it, vi } from 'vitest'
import { StreamDeltaBuffer, type DeltaBatch } from './stream-delta-buffer'

describe('StreamDeltaBuffer', () => {
  it('batches high-frequency deltas into a single flush callback', async () => {
    const flushes: DeltaBatch[][] = []
    const buffer = new StreamDeltaBuffer((batches) => {
      flushes.push(batches)
    }, 10)

    buffer.append('run-1', 'msg-1', 'Hello')
    buffer.append('run-1', 'msg-1', ' ')
    buffer.append('run-1', 'msg-1', 'World')
    buffer.append('run-1', 'msg-1', '!')

    expect(flushes).toHaveLength(0)
    expect(buffer.hasPending()).toBe(true)

    // Wait for batch timeout (or manual flush)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toEqual([
      {
        runId: 'run-1',
        messageId: 'msg-1',
        streamId: 'stream-msg-1',
        delta: 'Hello World!',
        at: undefined,
      },
    ])
    expect(buffer.hasPending()).toBe(false)
  })

  it('keeps distinct streams separate across runs or message ids', () => {
    const flushes: DeltaBatch[][] = []
    const buffer = new StreamDeltaBuffer((batches) => {
      flushes.push(batches)
    }, 50)

    buffer.append('run-1', 'msg-1', 'Alpha ')
    buffer.append('run-1', 'msg-2', 'Beta ')
    buffer.append('run-2', 'msg-1', 'Gamma ')
    buffer.append('run-1', 'msg-1', 'chunk 2')

    buffer.flush()

    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toHaveLength(3)
    const streamMap = new Map(flushes[0]!.map((b) => [`${b.runId}:${b.messageId}`, b.delta]))
    expect(streamMap.get('run-1:msg-1')).toBe('Alpha chunk 2')
    expect(streamMap.get('run-1:msg-2')).toBe('Beta ')
    expect(streamMap.get('run-2:msg-1')).toBe('Gamma ')
  })

  it('clears pending items without invoking flush', () => {
    const callback = vi.fn()
    const buffer = new StreamDeltaBuffer(callback, 50)

    buffer.append('run-1', 'msg-1', 'Text')
    buffer.clear()

    expect(buffer.hasPending()).toBe(false)
    buffer.flush()
    expect(callback).not.toHaveBeenCalled()
  })
})
