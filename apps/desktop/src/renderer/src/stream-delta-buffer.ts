export interface DeltaBatch {
  runId: string
  messageId: string
  streamId: string
  delta: string
  at?: string | undefined
}

export class StreamDeltaBuffer {
  private buffer = new Map<string, DeltaBatch>()
  private scheduled = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly flushCallback: (batches: DeltaBatch[]) => void
  private readonly maxIntervalMs: number

  constructor(flushCallback: (batches: DeltaBatch[]) => void, maxIntervalMs = 50) {
    this.flushCallback = flushCallback
    this.maxIntervalMs = maxIntervalMs
  }

  append(runId: string, messageId: string, delta: string, at?: string): void {
    const streamId = `stream-${messageId}`
    const key = `${runId}:${streamId}`
    const existing = this.buffer.get(key)
    if (existing) {
      existing.delta += delta
      if (at) existing.at = at
    } else {
      this.buffer.set(key, { runId, messageId, streamId, delta, at })
    }
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true

    const doFlush = () => {
      this.flush()
    }

    // rAF is paused while the window is hidden, so a timer bounds the delay.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (this.scheduled) doFlush() })
      this.timer = setTimeout(doFlush, Math.max(this.maxIntervalMs, 250))
    } else {
      this.timer = setTimeout(doFlush, this.maxIntervalMs)
    }
  }

  flush(): void {
    this.scheduled = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.size === 0) return
    const batches = Array.from(this.buffer.values())
    this.buffer.clear()
    this.flushCallback(batches)
  }

  clear(): void {
    this.scheduled = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer.clear()
  }

  hasPending(): boolean {
    return this.buffer.size > 0
  }
}
