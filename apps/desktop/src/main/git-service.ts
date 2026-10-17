import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitFileStatus, GitStatusResult } from '@deskforge/contracts'

const execFileAsync = promisify(execFile)

/**
 * Read-only Git status inspector for authorized workspaces.
 * Strictly executes `git status --porcelain=v1 -b` with a short timeout and clean environment.
 * Never executes write or remote network actions.
 */
export async function inspectGitStatus(workspacePath: string): Promise<GitStatusResult> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-b'],
      {
        cwd: workspacePath,
        timeout: 4000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
    )

    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0)
    let branch: string | undefined
    let ahead = 0
    let behind = 0
    const files: GitFileStatus[] = []

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const branchHeader = line.slice(3).trim()
        // Format: branch...remote [ahead X, behind Y] or Initial commit on branch or HEAD (no branch)
        const aheadMatch = branchHeader.match(/ahead\s+(\d+)/)
        if (aheadMatch && aheadMatch[1]) ahead = parseInt(aheadMatch[1], 10)
        const behindMatch = branchHeader.match(/behind\s+(\d+)/)
        if (behindMatch && behindMatch[1]) behind = parseInt(behindMatch[1], 10)

        const branchPart = branchHeader.split(/\s*\[/)[0] ?? ''
        const mainBranch = branchPart.split('...')[0]?.trim()
        branch = mainBranch || 'HEAD'
        continue
      }

      if (line.length < 4) continue
      const stagedCode = line[0] ?? ' '
      const unstagedCode = line[1] ?? ' '
      const rawPath = line.slice(3).trim().replace(/^"|"$/g, '')

      if (stagedCode === '?' && unstagedCode === '?') {
        files.push({ path: rawPath, status: 'untracked', staged: false })
      } else {
        if (stagedCode !== ' ' && stagedCode !== '?') {
          const status = stagedCode === 'A' ? 'added' : stagedCode === 'D' ? 'deleted' : stagedCode === 'R' ? 'renamed' : 'modified'
          files.push({ path: rawPath, status, staged: true })
        }
        if (unstagedCode !== ' ' && unstagedCode !== '?') {
          const status = unstagedCode === 'D' ? 'deleted' : 'modified'
          files.push({ path: rawPath, status, staged: false })
        }
      }
    }

    return {
      isGitRepo: true,
      ...(branch ? { branch } : {}),
      clean: files.length === 0,
      ...(ahead > 0 ? { ahead } : {}),
      ...(behind > 0 ? { behind } : {}),
      files,
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { isGitRepo: false, clean: true, files: [], error: '未安装 Git 或不可用' }
    }
    // git error code 128 typically means "not a git repository"
    const isNotRepo = err?.code === 128 || /not a git repository/i.test(err?.stderr || '')
    if (isNotRepo) {
      return { isGitRepo: false, clean: true, files: [] }
    }
    return {
      isGitRepo: false,
      clean: true,
      files: [],
      error: err?.message || 'Git 状态获取失败',
    }
  }
}
