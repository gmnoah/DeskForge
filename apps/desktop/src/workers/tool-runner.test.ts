import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BoundedTextCapture } from './tool-runner'
import { resolveSearchScope, searchContents } from './workspace-search'

describe('BoundedTextCapture', () => {
  it('returns small output unchanged and counts UTF-8 bytes', () => {
    const capture = new BoundedTextCapture(64)
    capture.append('hello ')
    capture.append('世界')

    expect(capture.snapshot()).toEqual({
      text: 'hello 世界',
      truncated: false,
      total: Buffer.byteLength('hello 世界'),
      omittedBytes: 0,
    })
  })

  it('keeps the head and latest tail while reporting omitted bytes', () => {
    const capture = new BoundedTextCapture(10)
    capture.append('abcdefghijklmnop')

    expect(capture.retainedBytes).toBe(10)
    expect(capture.snapshot()).toEqual({
      text: 'abcdefg\n\n…[已省略 6 bytes]…\n\nnop',
      truncated: true,
      total: 16,
      omittedBytes: 6,
    })
  })

  it('rolls the tail across many chunks without exceeding its byte budget', () => {
    const capture = new BoundedTextCapture(12)
    for (const chunk of ['abc', 'defgh', 'ijk', 'lm', 'nop']) capture.append(chunk)

    expect(capture.retainedBytes).toBeLessThanOrEqual(12)
    expect(capture.snapshot()).toEqual({
      text: 'abcdefghi\n\n…[已省略 4 bytes]…\n\nnop',
      truncated: true,
      total: 16,
      omittedBytes: 4,
    })
  })

  it('stays bounded after a very large chunk and subsequent output', () => {
    const capture = new BoundedTextCapture(128)
    capture.append(Buffer.alloc(2 * 1024 * 1024, 'x'))
    capture.append('final-line')

    const snapshot = capture.snapshot()
    expect(capture.retainedBytes).toBe(128)
    expect(snapshot.total).toBe(2 * 1024 * 1024 + Buffer.byteLength('final-line'))
    expect(snapshot.omittedBytes).toBe(snapshot.total - 128)
    expect(snapshot.text.endsWith('final-line')).toBe(true)
  })
})

describe('built-in file search fallback', () => {
  it('finds text without rg while skipping dependency and build directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskforge-search-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'report.md'), 'GraphRAG evidence\nsecond line\n')
    await writeFile(join(root, 'node_modules', 'ignored.txt'), 'GraphRAG hidden\n')

    const result = await searchContents(await resolveSearchScope(root, root, root), { query: 'GraphRAG', engine: 'builtin' }) as any
    expect(result).toMatchObject({ engine: 'builtin', matchCount: 1 })
    expect(result.matches[0]).toMatchObject({ path: 'src/report.md', line: 1, column: 1 })
    await rm(root, { recursive: true, force: true })
  })
})

describe('shell environment and PATH caching', () => {
  it('captures PATH and sanitizes startup-hook environment variables', async () => {
    const { getCachedShellPath, sanitizeEnv } = await import('./tool-runner')
    const path = getCachedShellPath()
    expect(typeof path).toBe('string')
    expect(path.length).toBeGreaterThan(0)

    const env = sanitizeEnv()
    expect(env.PATH).toBe(path)
    expect(env.ENV).toBeUndefined()
    expect(env.BASH_ENV).toBeUndefined()
    expect(env.ZDOTDIR).toBeUndefined()
  })
})

describe('runProcess progress buffering', () => {
  it('aggregates rapid stdout lines into fewer progress messages and flushes all content', async () => {
    const { runProcess, setTestMessageSink } = await import('./tool-runner')
    const messages: Array<Record<string, unknown>> = []
    setTestMessageSink((msg) => messages.push(msg))

    try {
      const script = "for(let i=0; i<50; i++) console.log('line-' + i);"
      const result = await runProcess('req-1', 'run-1', process.execPath, ['-e', script], process.cwd(), 5000)

      expect(result.code).toBe(0)
      const progressMessages = messages.filter((m) => m.type === 'progress' && m.channel === 'stdout')
      expect(progressMessages.length).toBeLessThan(15)
      const fullProgressText = progressMessages.map((m) => String(m.text)).join('')
      expect(fullProgressText).toContain('line-0')
      expect(fullProgressText).toContain('line-49')
      expect(result.stdout).toContain('line-0')
      expect(result.stdout).toContain('line-49')
    } finally {
      setTestMessageSink(undefined)
    }
  })
})

