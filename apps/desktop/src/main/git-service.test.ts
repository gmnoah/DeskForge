import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectGitStatus } from './git-service'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe('inspectGitStatus', () => {
  it('returns isGitRepo: false for a regular non-git folder', async () => {
    const dir = await tempDir('non-git-')
    const result = await inspectGitStatus(dir)
    expect(result.isGitRepo).toBe(false)
    expect(result.clean).toBe(true)
    expect(result.files).toEqual([])
  })

  it('inspects current git repository and detects active branch', async () => {
    // Run against DeskForge workspace root
    const result = await inspectGitStatus(process.cwd())
    expect(result.isGitRepo).toBe(true)
    expect(typeof result.branch).toBe('string')
    expect(result.branch!.length).toBeGreaterThan(0)
    expect(Array.isArray(result.files)).toBe(true)
  })
})
