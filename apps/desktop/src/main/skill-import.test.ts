import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppDatabase } from './database'
import {
  createGitCloner,
  gitCloneArgs,
  gitEnvironment,
  inspectSkillDirectory,
  normalizeSkillSubpath,
  resolveRepositorySubpath,
  SkillImportService,
  validateGitRef,
  validateGitUrl,
  type GitCloner,
} from './skill-import'
import { SkillService } from './skill-service'

const skillMarkdown = (name: string, extra = '', body = '按步骤整理材料。') => `---
name: ${name}
description: ${name} 的说明
metadata:
  deskforge:
    version: 1.0.0
${extra}---
${body}
`

async function writeSkill(directory: string, name = 'sample-skill', options: { extra?: string; script?: boolean } = {}): Promise<string> {
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), skillMarkdown(name, options.extra))
  await writeFile(join(directory, 'references', 'guide.md'), '# 参考')
  if (options.script) {
    await mkdir(join(directory, 'scripts'), { recursive: true })
    // Would leave a marker if anything executed it during import.
    await writeFile(join(directory, 'scripts', 'install.sh'), `#!/bin/sh\ntouch "${join(directory, 'EXECUTED')}"\n`, { mode: 0o755 })
  }
  return directory
}

const exists = (path: string) => access(path).then(() => true, () => false)

describe('skill import validation', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'deskforge-skill-inspect-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('accepts a well-formed folder and classifies files', async () => {
    const inspection = await inspectSkillDirectory(await writeSkill(join(root, 'ok'), 'ok-skill', { script: true }))
    expect(inspection.parsed).toMatchObject({ name: 'ok-skill', version: '1.0.0' })
    expect(inspection.files.map((file) => [file.path, file.kind])).toEqual([['references/guide.md', 'reference'], ['scripts/install.sh', 'script'], ['SKILL.md', 'entry']])
    expect(inspection.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects symlinked files, directories and roots anywhere in the package', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret')
    const fileLink = await writeSkill(join(root, 'file-link'))
    await symlink(join(outside, 'secret.txt'), join(fileLink, 'references', 'leak.txt'))
    await expect(inspectSkillDirectory(fileLink)).rejects.toThrow('Skill 包不能包含符号链接：references/leak.txt')

    const dirLink = await writeSkill(join(root, 'dir-link'))
    await symlink(outside, join(dirLink, 'assets'))
    await expect(inspectSkillDirectory(dirLink)).rejects.toThrow('符号链接：assets')

    const entryLink = join(root, 'entry-link'); await mkdir(entryLink)
    await writeFile(join(outside, 'SKILL.md'), skillMarkdown('linked'))
    await symlink(join(outside, 'SKILL.md'), join(entryLink, 'SKILL.md'))
    await expect(inspectSkillDirectory(entryLink)).rejects.toThrow('符号链接：SKILL.md')

    const real = await writeSkill(join(root, 'real'))
    await symlink(real, join(root, 'root-link'))
    await expect(inspectSkillDirectory(join(root, 'root-link'))).rejects.toThrow('本身不能是符号链接')
  })

  it('explains SKILL.md problems in Chinese', async () => {
    const cases: Array<[string, string]> = [
      ['没有 frontmatter', 'frontmatter'],
      ['---\nname: x\ndescription: y\n正文', '未闭合'],
      ['---\nname: [x\n---\n正文', 'frontmatter 解析失败'],
      ['---\ndescription: y\n---\n正文', '缺少 name'],
      ['---\nname: x\n---\n正文', '缺少 description'],
      ['---\nname: x\ndescription: y\n---\n   \n', '正文为空'],
    ]
    for (const [index, [content, message]] of cases.entries()) {
      const directory = join(root, `bad-${index}`); await mkdir(directory)
      await writeFile(join(directory, 'SKILL.md'), content)
      await expect(inspectSkillDirectory(directory), content).rejects.toThrow(message)
    }
    const missing = join(root, 'missing'); await mkdir(missing)
    await expect(inspectSkillDirectory(missing)).rejects.toThrow('缺少 SKILL.md')
    await expect(inspectSkillDirectory(join(root, 'nope'))).rejects.toThrow('找不到文件夹')
  })

  it('validates git URLs, refs and subpaths before cloning', () => {
    expect(validateGitUrl(' https://github.com/acme/skills ').toString()).toBe('https://github.com/acme/skills')
    for (const url of ['git@github.com:acme/skills.git', 'ssh://git@github.com/acme/skills', 'http://github.com/acme/skills', 'file:///tmp/repo', 'git://github.com/a/b', 'https://user:token@github.com/a/b', 'https://localhost/a', 'https://127.0.0.1/a', 'https://192.168.1.2/a', 'https://github.com/a/b?x=1', 'not a url']) {
      expect(() => validateGitUrl(url), url).toThrow()
    }
    expect(validateGitRef(' v1.2.0 ')).toBe('v1.2.0')
    expect(validateGitRef('')).toBeUndefined()
    for (const ref of ['--upload-pack=evil', '../x', 'a b', 'a//b', '/main', 'x.lock']) expect(() => validateGitRef(ref), ref).toThrow('分支或标签名无效')
    expect(normalizeSkillSubpath('skills/weekly/')).toBe('skills/weekly')
    expect(normalizeSkillSubpath('.')).toBeUndefined()
    for (const subpath of ['../etc', 'skills/../../x', '/etc', 'C:/x', 'a//b', 'a\\b', 'a/./b']) expect(() => normalizeSkillSubpath(subpath), subpath).toThrow()
  })

  it('refuses symlinked or escaping subpath segments inside a clone', async () => {
    const repo = join(root, 'repo'); await writeSkill(join(repo, 'skills', 'real'))
    const outside = await writeSkill(join(root, 'outside-skill'))
    await symlink(outside, join(repo, 'skills', 'linked'))
    await symlink(join(repo, 'skills'), join(repo, 'alias'))
    expect(await resolveRepositorySubpath(repo, 'skills/real')).toBe(join(await import('node:fs/promises').then((fs) => fs.realpath(repo)), 'skills', 'real'))
    await expect(resolveRepositorySubpath(repo, 'skills/linked')).rejects.toThrow('符号链接')
    await expect(resolveRepositorySubpath(repo, 'alias/real')).rejects.toThrow('符号链接')
    await expect(resolveRepositorySubpath(repo, 'skills/none')).rejects.toThrow('找不到子目录')
  })

  it('builds a hermetic, non-executing git clone invocation', () => {
    const args = gitCloneArgs('https://github.com/acme/skills', 'main', '/tmp/x/repo')
    expect(args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'protocol.allow=never', 'protocol.https.allow=always', '--depth', '1', '--no-recurse-submodules']))
    expect(args.slice(-3)).toEqual(['--', 'https://github.com/acme/skills', '/tmp/x/repo'])
    expect(args[args.indexOf('--branch') + 1]).toBe('main')
    const env = gitEnvironment({ PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_secret', GIT_SSH_COMMAND: 'evil', HTTPS_PROXY: 'http://proxy' }, '/tmp/home')
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/home', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1', HTTPS_PROXY: 'http://proxy' })
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('GIT_SSH_COMMAND')
  })

  it('the real git cloner refuses non-HTTPS transports even if validation were bypassed', async () => {
    const destination = join(root, 'clone'); await mkdir(destination)
    await expect(createGitCloner({ timeoutMs: 20_000 })({ url: `file://${root}`, destination })).rejects.toThrow()
    expect(await exists(join(destination, 'repo', 'SKILL.md'))).toBe(false)
  }, 30_000)
})

describe('SkillImportService', () => {
  let root: string
  let database: AppDatabase
  let skills: SkillService
  let clones: Array<{ url: string; ref?: string }>
  let repoBuilder: (repo: string) => Promise<void>
  let service: SkillImportService

  const fakeCloner: GitCloner = async ({ url, ref, destination }) => {
    clones.push({ url, ...(ref ? { ref } : {}) })
    await repoBuilder(join(destination, 'repo'))
    return { commit: 'a'.repeat(40) }
  }
  const tempRoot = () => join(root, 'skill-imports')

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deskforge-skill-import-'))
    database = new AppDatabase(join(root, 'app.sqlite3'))
    skills = new SkillService(database, join(root, 'installed'))
    clones = []
    repoBuilder = async (repo) => { await writeSkill(join(repo, 'skills', 'weekly'), 'git-weekly', { script: true }) }
    service = new SkillImportService(skills, { tempRoot: tempRoot(), cloner: fakeCloner })
  })

  afterEach(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  it('previews a folder, installs it on confirm with its source, and never runs scripts', async () => {
    const source = await writeSkill(join(root, 'source'), 'folder-skill', { script: true, extra: 'permissions:\n  - shell\n' })
    const preview = await service.previewFolder(source)
    expect(preview).toMatchObject({ name: 'folder-skill', version: '1.0.0', fileCount: 3, scriptFiles: ['scripts/install.sh'], source: { kind: 'folder' } })
    expect(preview.warnings.join('\n')).toContain('不会执行')
    expect(preview.warnings.join('\n')).toContain('Shell')
    expect(preview.replaces).toBeUndefined()
    expect(await skills.list()).toHaveLength(0)

    const installed = await service.confirm(preview.selectionId)
    expect(installed).toMatchObject({ name: 'folder-skill', enabled: true, source: { kind: 'folder' } })
    expect((installed.source as any).importedAt).toBeTruthy()
    expect(await exists(join(source, 'EXECUTED'))).toBe(false)
    await expect(service.confirm(preview.selectionId)).rejects.toThrow('已失效')
  })

  it('refuses to confirm when files change after preview', async () => {
    const source = await writeSkill(join(root, 'source'), 'changing-skill')
    const preview = await service.previewFolder(source)
    await writeFile(join(source, 'references', 'guide.md'), '# 被改过')
    await expect(service.confirm(preview.selectionId)).rejects.toThrow('发生了变化')
    expect(await skills.list()).toHaveLength(0)
  })

  it('expires stale previews', async () => {
    let clock = Date.now()
    const timed = new SkillImportService(skills, { tempRoot: tempRoot(), cloner: fakeCloner, now: () => clock })
    const preview = await timed.previewFolder(await writeSkill(join(root, 'source'), 'stale-skill'))
    clock += 60 * 60 * 1000
    await expect(timed.confirm(preview.selectionId)).rejects.toThrow('过期')
  })

  it('imports from a git subpath, records the commit and cleans the temporary clone', async () => {
    const preview = await service.previewGit({ url: 'https://github.com/acme/skills', ref: 'main', subpath: 'skills/weekly' })
    expect(clones).toEqual([{ url: 'https://github.com/acme/skills', ref: 'main' }])
    expect(preview).toMatchObject({ name: 'git-weekly', source: { kind: 'git', url: 'https://github.com/acme/skills', ref: 'main', subpath: 'skills/weekly', commit: 'a'.repeat(40) } })
    expect(await readdir(tempRoot())).toHaveLength(1)
    const installed = await service.confirm(preview.selectionId)
    expect(installed.source).toMatchObject({ kind: 'git', subpath: 'skills/weekly', commit: 'a'.repeat(40) })
    expect(await readdir(tempRoot())).toHaveLength(0)

    const cancelled = await service.previewGit({ url: 'https://github.com/acme/skills', subpath: 'skills/weekly' })
    expect(cancelled.replaces).toMatchObject({ id: installed.id })
    await service.cancel(cancelled.selectionId)
    expect(await readdir(tempRoot())).toHaveLength(0)
  })

  it('rejects bad git input and symlinked subpaths without leaving clones behind', async () => {
    await expect(service.previewGit({ url: 'git@github.com:acme/skills.git' })).rejects.toThrow('https://')
    await expect(service.previewGit({ url: 'https://github.com/acme/skills', subpath: '../outside' })).rejects.toThrow('..')
    expect(clones).toHaveLength(0)

    const outside = await writeSkill(join(root, 'outside-skill'), 'outside')
    repoBuilder = async (repo) => { await mkdir(join(repo, 'skills'), { recursive: true }); await symlink(outside, join(repo, 'skills', 'weekly')) }
    await expect(service.previewGit({ url: 'https://github.com/acme/skills', subpath: 'skills/weekly' })).rejects.toThrow('符号链接')
    repoBuilder = async (repo) => { await writeSkill(join(repo, 'skills', 'weekly')); await symlink('/etc/passwd', join(repo, 'skills', 'weekly', 'references', 'passwd')) }
    await expect(service.previewGit({ url: 'https://github.com/acme/skills', subpath: 'skills/weekly' })).rejects.toThrow('符号链接：references/passwd')
    repoBuilder = async (repo) => { await mkdir(join(repo, 'docs'), { recursive: true }) }
    await expect(service.previewGit({ url: 'https://github.com/acme/skills' })).rejects.toThrow('缺少 SKILL.md')
    expect(await readdir(tempRoot())).toHaveLength(0)
  })

  it('updates from the recorded source, keeping the enabled state, and removes skills', async () => {
    const source = await writeSkill(join(root, 'source'), 'update-skill')
    const installed = await service.confirm((await service.previewFolder(source)).selectionId)
    await skills.setEnabled(installed.id, false)
    await writeFile(join(source, 'SKILL.md'), skillMarkdown('update-skill', '', '新版说明').replace('1.0.0', '1.1.0'))
    const update = await service.previewUpdate(installed.id)
    expect(update).toMatchObject({ version: '1.1.0', replaces: { id: installed.id, version: '1.0.0', enabled: false } })
    const updated = await service.confirm(update.selectionId)
    expect(updated).toMatchObject({ id: installed.id, version: '1.1.0', enabled: false })

    await writeFile(join(source, 'SKILL.md'), skillMarkdown('renamed-skill'))
    await expect(service.previewUpdate(installed.id)).rejects.toThrow('名称已变为')
    await rm(source, { recursive: true })
    await expect(service.previewUpdate(installed.id)).rejects.toThrow('无法从原文件夹更新')

    const removed = await skills.remove(installed.id)
    expect(removed.name).toBe('update-skill')
    expect(await skills.list()).toHaveLength(0)
  })

  it('does not re-import bundled skills from a source', async () => {
    const bundled = await skills.importDirectory(await writeSkill(join(root, 'bundled'), 'bundled-skill'), { source: { kind: 'bundled' } })
    await expect(service.previewUpdate(bundled.id)).rejects.toThrow('内置 Skill')
  })
})
