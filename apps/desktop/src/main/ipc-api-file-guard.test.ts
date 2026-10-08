import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { ArtifactStore } from './artifact-store'
import { IpcApi } from './ipc-api'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setupIpc() {
  const directory = await mkdtemp(join(tmpdir(), 'deskforge-ipc-file-guard-'))
  directories.push(directory)
  const outsideDir = await mkdtemp(join(tmpdir(), 'deskforge-outside-'))
  directories.push(outsideDir)

  const database = new AppDatabase(join(directory, 'state.sqlite3'))
  const artifacts = new ArtifactStore(join(directory, 'artifacts'), database)
  const wsId = database.addWorkspace(directory, 'TestWS')

  const ipc = new IpcApi(
    database,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    artifacts,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  )

  return { directory, outsideDir, database, artifacts, wsId, ipc }
}

describe('S1 File IPC path authorization and bounded reading', () => {
  it('reads authorized files within workspace and respects maxBytes limit', async () => {
    const { directory, ipc } = await setupIpc()
    const filePath = join(directory, 'large.txt')
    const largeContent = Buffer.alloc(5 * 1024 * 1024, 'a')
    await writeFile(filePath, largeContent)

    // Default limit (2 MB)
    const result = await ipc.handlers['app:read-file-content']({ path: filePath })
    expect(result.size).toBe(5 * 1024 * 1024)
    expect(result.text.length).toBe(2 * 1024 * 1024)
    expect(result.truncated).toBe(true)

    // Custom limit (100 KB)
    const smallResult = await ipc.handlers['app:read-file-content']({ path: filePath, maxBytes: 100 * 1024 })
    expect(smallResult.text.length).toBe(100 * 1024)
    expect(smallResult.truncated).toBe(true)
  })

  it('rejects paths outside authorized workspaces such as ~/.ssh/id_rsa or /etc', async () => {
    const { outsideDir, ipc } = await setupIpc()
    const outsideFile = join(outsideDir, 'secret.txt')
    await writeFile(outsideFile, 'secret-data')

    // Read outside workspace
    await expect(ipc.handlers['app:read-file-content']({ path: outsideFile }))
      .rejects.toThrow(/outside authorized workspace roots/i)

    // Reveal outside workspace
    await expect(ipc.handlers['app:reveal-path']({ path: outsideFile }))
      .rejects.toThrow(/outside authorized workspace roots/i)

    // Sensitive path
    const sshPath = join(homedir(), '.ssh', 'id_rsa')
    await expect(ipc.handlers['app:read-file-content']({ path: sshPath }))
      .rejects.toThrow()
  })

  it('rejects symlink escapes pointing outside workspace', async () => {
    const { directory, outsideDir, ipc } = await setupIpc()
    const outsideFile = join(outsideDir, 'external.txt')
    await writeFile(outsideFile, 'secret')

    const symlinkPath = join(directory, 'escaped-link.txt')
    await symlink(outsideFile, symlinkPath)

    await expect(ipc.handlers['app:read-file-content']({ path: symlinkPath }))
      .rejects.toThrow(/outside authorized workspace roots/i)
  })

  it('rejects opening executable files in app:open-path', async () => {
    const { directory, ipc } = await setupIpc()
    const scriptPath = join(directory, 'malicious.sh')
    await writeFile(scriptPath, '#!/bin/sh\necho evil\n')

    const result = await ipc.handlers['app:open-path']({ path: scriptPath })
    expect(result.success).toBe(false)
    expect(result.error).toContain('安全限制：禁止直接打开可执行程序或脚本文件')

    const appPath = join(directory, 'dangerous.app')
    await writeFile(appPath, '')
    const appResult = await ipc.handlers['app:open-path']({ path: appPath })
    expect(appResult.success).toBe(false)
    expect(appResult.error).toContain('安全限制')
  })
})
