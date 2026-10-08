/**
 * Hard deny for destructive shell commands that target paths outside the
 * authorized workspace (or the home directory / filesystem root). These are
 * blocked outright; approval cards and session rules cannot override them.
 */

const DESTRUCTIVE_EXECUTABLES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'truncate'])
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'time', 'nice', 'env', 'xargs'])
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const INLINE_SCRIPT_INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'perl', 'ruby', 'php', 'deno', 'bun'])

export interface DestructiveShellFinding {
  executable: string
  target: string
  reason: string
  /**
   * The command cannot be proven safe but is not known to be destructive
   * (e.g. `python3 -c`). Callers require a one-time approval instead of denying.
   */
  confirmOnly?: boolean
}

function stripQuotes(token: string): string {
  return token.replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
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

function splitTopLevelSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (
        (char === '&' && command[i + 1] === '&') ||
        (char === '|' && command[i + 1] === '|')
      ) {
        if (current.trim()) segments.push(current.trim())
        current = ''
        i++
      } else if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')' || char === '\n' || char === '\r') {
        if (current.trim()) segments.push(current.trim())
        current = ''
      } else {
        current += char
      }
    } else {
      current += char
    }
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

/** Bodies of `$(…)` and backtick substitutions; both also expand inside double quotes. */
function commandSubstitutions(command: string): string[] {
  const bodies: string[] = []
  let inSingleQuote = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\') { i++; continue }
    if (char === "'") { inSingleQuote = !inSingleQuote; continue }
    if (inSingleQuote) continue
    if (char === '$' && command[i + 1] === '(') {
      let depth = 1
      let end = i + 2
      while (end < command.length && depth > 0) {
        if (command[end] === '(') depth++
        else if (command[end] === ')') depth--
        end++
      }
      bodies.push(command.slice(i + 2, depth === 0 ? end - 1 : end))
      i = end - 1
    } else if (char === '`') {
      const close = command.indexOf('`', i + 1)
      const end = close === -1 ? command.length : close
      bodies.push(command.slice(i + 1, end))
      i = end
    }
  }
  return bodies.filter((body) => body.trim())
}

/** Returns the first destructive command segment that escapes the workspace, if any. */
export function findDestructiveShellOutsideWorkspace(
  command: string,
  workspaceRoot: string,
  cwd: string = workspaceRoot,
  depth: number = 0,
): DestructiveShellFinding | undefined {
  if (depth > 5) {
    return { executable: 'nested-command', target: command, reason: '命令嵌套层级过深，无法静态确认安全性' }
  }

  for (const body of commandSubstitutions(command)) {
    const innerFinding = findDestructiveShellOutsideWorkspace(body, workspaceRoot, cwd, depth + 1)
    if (innerFinding) return { ...innerFinding, executable: `$(${innerFinding.executable})` }
  }

  const segments = splitTopLevelSegments(command)
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue

    const tokens = trimmed.split(/\s+/).filter(Boolean)
    let index = 0
    while (
      index < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!) ||
        WRAPPERS.has(tokens[index]!.toLowerCase()) ||
        (index > 0 && tokens[index]!.startsWith('-') && WRAPPERS.has(tokens[index - 1]!.toLowerCase())))
    ) {
      index += 1
    }

    const executable = (tokens[index] ?? '').split('/').at(-1)?.toLowerCase() ?? ''

    // 1. Recursive check for shell wrapper execution (bash -c, sh -c, zsh -c, dash -c)
    if (SHELL_INTERPRETERS.has(executable)) {
      const cIndex = tokens.findIndex((t, i) => i > index && /^-[a-zA-Z]*c$/.test(t))
      if (cIndex !== -1) {
        const rawInner = tokens.slice(cIndex + 1).join(' ').trim()
        const unquoted = stripQuotes(rawInner)
        if (!unquoted || unquoted.startsWith('$') || /\$\(|`/.test(unquoted)) {
          return { executable: `${executable} -c`, target: unquoted || rawInner, reason: '命令包含无法静态解析的变量或动态命令' }
        }
        const innerFinding = findDestructiveShellOutsideWorkspace(unquoted, workspaceRoot, cwd, depth + 1)
        if (innerFinding) {
          return { executable: `${executable} -c (${innerFinding.executable})`, target: innerFinding.target, reason: innerFinding.reason }
        }
        continue
      }
    }

    // 2. Recursive check for eval
    if (executable === 'eval') {
      const rawInner = tokens.slice(index + 1).join(' ').trim()
      const unquoted = stripQuotes(rawInner)
      if (!unquoted || unquoted.startsWith('$') || /\$\(|`/.test(unquoted)) {
        return { executable: 'eval', target: unquoted || rawInner, reason: '命令包含无法静态解析的变量或动态命令' }
      }
      const innerFinding = findDestructiveShellOutsideWorkspace(unquoted, workspaceRoot, cwd, depth + 1)
      if (innerFinding) {
        return { executable: `eval (${innerFinding.executable})`, target: innerFinding.target, reason: innerFinding.reason }
      }
      continue
    }

    // 3. Inline script interpreters (python3 -c, node -e, perl -e, etc.)
    if (INLINE_SCRIPT_INTERPRETERS.has(executable)) {
      const hasInlineFlag = tokens.some((t, i) => i > index && (t === '-c' || t === '-e'))
      if (hasInlineFlag) {
        return { executable, target: tokens.slice(index + 1).join(' '), reason: '解释器内联执行无法静态确认安全性', confirmOnly: true }
      }
    }

    // 4. Source execution: source script or . script
    if (executable === 'source' || executable === '.') {
      const scriptToken = tokens[index + 1]
      if (scriptToken) {
        const reason = classifyTarget(scriptToken, workspaceRoot, cwd)
        if (reason) {
          return { executable, target: stripQuotes(scriptToken), reason: `通过 ${executable} 执行未确认脚本（${reason}）` }
        }
        if (/^\$/.test(stripQuotes(scriptToken))) {
          return { executable, target: stripQuotes(scriptToken), reason: '脚本路径包含无法静态确认的变量' }
        }
      }
    }

    // 5. Destructive executables: rm, rmdir, shred, find -delete, etc.
    const findDelete = executable === 'find' && tokens.some((token) => token === '-delete' || (token === '-exec' && tokens.includes('rm')))
    if (!DESTRUCTIVE_EXECUTABLES.has(executable) && !findDelete) continue
    for (const token of tokens.slice(index + 1)) {
      if (token.startsWith('-') && token !== '-') continue
      const reason = classifyTarget(token, workspaceRoot, cwd)
      if (reason) return { executable, target: stripQuotes(token), reason }
    }
  }
  return undefined
}
