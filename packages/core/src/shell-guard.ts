/**
 * Hard deny for destructive shell commands that target paths outside the
 * authorized workspace (or the home directory / filesystem root). These are
 * blocked outright; approval cards and session rules cannot override them.
 */

const DESTRUCTIVE_EXECUTABLES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'truncate'])
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'time', 'nice', 'env', 'xargs'])

export interface DestructiveShellFinding {
  executable: string
  target: string
  reason: string
}

function stripQuotes(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2')
}

function normalizePosix(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function within(root: string, target: string): boolean {
  const normalizedRoot = normalizePosix(root)
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`)
}

function classifyTarget(raw: string, workspaceRoot: string, cwd: string): string | undefined {
  const target = stripQuotes(raw)
  if (!target) return undefined
  if (/^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/.test(target)) return '目标位于用户主目录'
  if (/^\$/.test(target)) return '目标路径包含无法静态确认的变量'
  if (target === '/' || /^\/\*?$/.test(target)) return '目标是磁盘根目录'
  if (target.split('/').includes('..')) {
    const resolved = normalizePosix(target.startsWith('/') ? target : `${cwd}/${target}`)
    if (!within(workspaceRoot, resolved)) return '目标通过 .. 跳出授权工作区'
  }
  if (target.startsWith('/')) {
    if (!within(workspaceRoot, normalizePosix(target))) return '目标是工作区以外的绝对路径'
    if (normalizePosix(target) === normalizePosix(workspaceRoot)) return '目标是整个工作区根目录'
  }
  return undefined
}

/** Returns the first destructive command segment that escapes the workspace, if any. */
export function findDestructiveShellOutsideWorkspace(command: string, workspaceRoot: string, cwd: string = workspaceRoot): DestructiveShellFinding | undefined {
  const segments = command.split(/(?:&&|\|\||[;&|\n\r]|\$\(|`|\))/)
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!) || WRAPPERS.has(tokens[index]!.toLowerCase()) || (index > 0 && tokens[index]!.startsWith('-') && WRAPPERS.has(tokens[index - 1]!.toLowerCase())))) index += 1
    const executable = (tokens[index] ?? '').split('/').at(-1)?.toLowerCase() ?? ''
    const findDelete = executable === 'find' && tokens.some((token) => token === '-delete' || token === '-exec' && tokens.includes('rm'))
    if (!DESTRUCTIVE_EXECUTABLES.has(executable) && !findDelete) continue
    for (const token of tokens.slice(index + 1)) {
      if (token.startsWith('-') && token !== '-') continue
      const reason = classifyTarget(token, workspaceRoot, cwd)
      if (reason) return { executable, target: stripQuotes(token), reason }
    }
  }
  return undefined
}
