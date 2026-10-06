import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAuthorizedPath } from './runner-security'
import { compileNameMatcher, findFiles, isWithinRoot, resolveSearchScope, ripgrepArgs, searchContents } from './workspace-search'

const hasRipgrep = spawnSync('rg', ['--version']).status === 0

let sandbox: string
let root: string
let outside: string

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'deskforge-search-')))
  root = join(sandbox, 'workspace')
  outside = join(sandbox, 'outside')
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n!keep.log\n')
  await writeFile(join(root, 'src', '.gitignore'), 'generated.ts\n')
  await writeFile(join(root, 'src', 'app.ts'), 'export const Needle = 1\nconst other = "needle"\n')
  await writeFile(join(root, 'src', 'nested', 'util.ts'), 'needle in nested\n')
  await writeFile(join(root, 'src', 'generated.ts'), 'needle generated\n')
  await writeFile(join(root, 'README.md'), '# Needle docs\n')
  await writeFile(join(root, 'debug.log'), 'needle log\n')
  await writeFile(join(root, 'keep.log'), 'needle kept\n')
  await writeFile(join(root, 'dist', 'bundle.js'), 'needle bundle\n')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'needle dep\n')
  await writeFile(join(root, '.git', 'config'), 'needle git\n')
  await writeFile(join(outside, 'secret.ts'), 'needle secret outside\n')
  await symlink(outside, join(root, 'linked-outside'))
  await symlink(join(outside, 'secret.ts'), join(root, 'src', 'secret-link.ts'))
})

afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

const paths = (result: any): string[] => result.matches.map((match: any) => match.path).sort()

describe('workspace search confinement', () => {
  it('finds files by glob and substring while honouring nested and root .gitignore', async () => {
    const scope = await resolveSearchScope(root, root, root)
    expect(paths(await findFiles(scope, { pattern: '*.ts' }))).toEqual(['src/app.ts', 'src/nested/util.ts'])
    expect(paths(await findFiles(scope, { pattern: 'UTIL' }))).toEqual(['src/nested/util.ts'])
    expect(paths(await findFiles(scope, { pattern: '*.log' }))).toEqual(['keep.log'])
    expect(paths(await findFiles(scope, { pattern: 'src/**/*.ts' }))).toEqual(['src/app.ts', 'src/nested/util.ts'])
    const dirs = await findFiles(scope, { pattern: 'nest', type: 'directory' }) as any
    expect(dirs.matches).toEqual([{ path: 'src/nested', type: 'directory' }])
  })

  it('applies parent .gitignore rules when searching a subdirectory and reports workspace-relative paths', async () => {
    await writeFile(join(root, 'src', 'nested', 'trace.log'), 'needle\n')
    const scope = await resolveSearchScope(root, join(root, 'src'), root)
    const found = await findFiles(scope, { pattern: '*' }) as any
    expect(paths(found)).toEqual(['src/.gitignore', 'src/app.ts', 'src/nested/util.ts'])
  })

  it('never follows symlinks that point outside the workspace', async () => {
    const scope = await resolveSearchScope(root, root, root)
    const found = await findFiles(scope, { pattern: 'secret' }) as any
    expect(found.matches).toEqual([])
    expect(found.skipped.symlinks).toBe(2)
    const builtin = await searchContents(scope, { query: 'secret outside', engine: 'builtin' }) as any
    expect(builtin.matches).toEqual([])
  })

  it('rejects a search base that escapes via .. or a symlinked directory', async () => {
    await expect(resolveAuthorizedPath(root, '../outside', false, root)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(resolveAuthorizedPath(root, 'linked-outside', false, root)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(resolveSearchScope(root, outside)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(resolveSearchScope(root, join(root, 'linked-outside'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(resolveSearchScope(root, join(root, 'README.md'))).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' })
    expect(isWithinRoot(root, join(root, '..', 'outside'))).toBe(false)
    expect(isWithinRoot(root, join(root, '..workspace-sibling'))).toBe(true)
  })

  it('searches contents literally by default, supports regex, case sensitivity and glob filters', async () => {
    const scope = await resolveSearchScope(root, root, root)
    const literal = await searchContents(scope, { query: 'needle', engine: 'builtin' }) as any
    expect(paths(literal)).toEqual(['README.md', 'keep.log', 'src/app.ts', 'src/app.ts', 'src/nested/util.ts'])
    expect(literal.matches.find((match: any) => match.path === 'src/app.ts')).toMatchObject({ line: 1, column: 14 })
    const sensitive = await searchContents(scope, { query: 'Needle', caseSensitive: true, engine: 'builtin' }) as any
    expect(paths(sensitive)).toEqual(['README.md', 'src/app.ts'])
    const regex = await searchContents(scope, { query: 'need(le)? in', regex: true, engine: 'builtin' }) as any
    expect(paths(regex)).toEqual(['src/nested/util.ts'])
    const dotLiteral = await searchContents(scope, { query: 'n.edle', engine: 'builtin' }) as any
    expect(dotLiteral.matches).toEqual([])
    const globbed = await searchContents(scope, { query: 'needle', glob: '*.md', engine: 'builtin' }) as any
    expect(paths(globbed)).toEqual(['README.md'])
    await expect(searchContents(scope, { query: '(', regex: true, engine: 'builtin' })).rejects.toMatchObject({ code: 'INVALID_REGEX' })
  })

  it('skips binary and oversized files and caps results with a limit reason', async () => {
    await writeFile(join(root, 'image.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]))
    await writeFile(join(root, 'huge.txt'), `needle\n${'x'.repeat(4096)}`)
    for (let index = 0; index < 30; index += 1) await writeFile(join(root, 'src', `many-${index}.txt`), 'needle\n')
    const scope = await resolveSearchScope(root, root, root)
    const result = await searchContents(scope, { query: 'needle', engine: 'builtin', maxFileBytes: 1024, maxResults: 10 }) as any
    expect(result.matches).toHaveLength(10)
    expect(result).toMatchObject({ truncated: true, limitReason: 'max_results' })
    const all = await searchContents(scope, { query: 'needle', engine: 'builtin', maxFileBytes: 1024 }) as any
    expect(all.skipped.binary).toBe(1)
    expect(all.skipped.tooLarge).toBe(1)
    expect(paths(all)).not.toContain('image.bin')
    const capped = await findFiles(scope, { pattern: 'many-*', maxResults: 5 }) as any
    expect(capped).toMatchObject({ truncated: true, limitReason: 'max_results' })
    const budget = await findFiles(scope, { pattern: '*', maxEntries: 3 }) as any
    expect(budget).toMatchObject({ truncated: true, limitReason: 'max_entries' })
  })

  it('builds ripgrep arguments that cannot follow links, read config or escape the base', () => {
    const args = ripgrepArgs({ root, base: join(root, 'src') }, { query: '--files', glob: '*.ts' })
    expect(args).toEqual(expect.arrayContaining(['--no-follow', '--no-config', '--fixed-strings', '--ignore-case', '--no-require-git']))
    expect(args.slice(-4)).toEqual(['--regexp', '--files', '--', join(root, 'src')])
  })

  it.skipIf(!hasRipgrep)('ripgrep engine returns the same confined, gitignore-aware matches', async () => {
    const scope = await resolveSearchScope(root, root, root)
    const result = await searchContents(scope, { query: 'needle', engine: 'ripgrep' }) as any
    expect(result.engine).toBe('ripgrep')
    expect(paths(result)).toEqual(['README.md', 'keep.log', 'src/app.ts', 'src/app.ts', 'src/nested/util.ts'])
    const capped = await searchContents(scope, { query: 'needle', engine: 'ripgrep', maxResults: 2 }) as any
    expect(capped.matches).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })

  it('compiles name matchers with basename semantics unless a slash is present', () => {
    expect(compileNameMatcher('*.TS')('src/a.ts')).toBe(true)
    expect(compileNameMatcher('src/*.ts')('lib/src/a.ts')).toBe(false)
    expect(() => compileNameMatcher('  ')).toThrow()
  })
})
