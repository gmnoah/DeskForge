import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunPreparationPipeline } from './run-preparation-pipeline'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  directory: string
  pipeline: RunPreparationPipeline
}> {
  const directory = await mkdtemp(join(tmpdir(), 'deskforge-prep-'))
  directories.push(directory)
  const database = { audit: vi.fn(), getSetting: vi.fn() } as any
  const artifacts = {} as any
  const pipeline = new RunPreparationPipeline(database, artifacts, vi.fn())
  return { directory, pipeline }
}

describe('RunPreparationPipeline workspace rules loading', () => {
  it('loads AGENTS.md with highest priority from workspace root', async () => {
    const { directory, pipeline } = await fixture()
    const workspaceRoot = join(directory, 'project')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'AGENTS.md'), '# Project AGENTS Rules\n- Use standard scripts\n', 'utf8')
    await writeFile(join(workspaceRoot, 'WORKBUDDY.md'), '# Legacy rules to ignore\n', 'utf8')

    const rules = await pipeline.loadWorkspaceRules(
      { id: 'run-1' },
      { id: 'ws-1', root_path: workspaceRoot, rules: '' },
    )

    expect(rules).toHaveLength(1)
    expect(rules[0]!.source).toBe('AGENTS.md')
    expect(rules[0]!.content).toContain('# Project AGENTS Rules')
    // Legacy WORKBUDDY.md is ignored when AGENTS.md exists
    expect(rules.some((r) => r.source === 'WORKBUDDY.md')).toBe(false)
  })

  it('deduplicates AGENTS.md and agents.md without redundant rules', async () => {
    const { directory, pipeline } = await fixture()
    const workspaceRoot = join(directory, 'project-dedupe')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'AGENTS.md'), '# Single AGENTS\n', 'utf8')

    const rules = await pipeline.loadWorkspaceRules(
      { id: 'run-dedupe' },
      { id: 'ws-dedupe', root_path: workspaceRoot, rules: '' },
    )

    // Should only have 1 AGENTS.md even if filesystem or check runs both casing candidates
    expect(rules.filter((r) => r.source.toLowerCase().includes('agents.md'))).toHaveLength(1)
  })

  it('loads .deskforge/rules.md alongside AGENTS.md', async () => {
    const { directory, pipeline } = await fixture()
    const workspaceRoot = join(directory, 'project')
    await mkdir(join(workspaceRoot, '.deskforge'), { recursive: true })
    await writeFile(join(workspaceRoot, 'AGENTS.md'), '# AGENTS spec\n', 'utf8')
    await writeFile(join(workspaceRoot, '.deskforge', 'rules.md'), '# DeskForge specific rules\n', 'utf8')

    const rules = await pipeline.loadWorkspaceRules(
      { id: 'run-1' },
      { id: 'ws-1', root_path: workspaceRoot, rules: '' },
    )

    expect(rules.map((r) => r.source)).toEqual(['AGENTS.md', join('.deskforge', 'rules.md')])
  })

  it('ascends to ancestor repository directory to inherit repo-level AGENTS.md', async () => {
    const { directory, pipeline } = await fixture()
    const repoRoot = join(directory, 'monorepo')
    const subProject = join(repoRoot, 'apps', 'sub-service')
    await mkdir(subProject, { recursive: true })
    await mkdir(join(repoRoot, '.git'), { recursive: true })
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Monorepo Root AGENTS Charter\n', 'utf8')

    const rules = await pipeline.loadWorkspaceRules(
      { id: 'run-2' },
      { id: 'ws-2', root_path: subProject, rules: '' },
    )

    expect(rules).toHaveLength(1)
    expect(rules[0]!.source).toBe('repo:AGENTS.md')
    expect(rules[0]!.content).toContain('# Monorepo Root AGENTS Charter')
  })

  it('falls back to legacy WORKBUDDY.md if no AGENTS.md exists anywhere', async () => {
    const { directory, pipeline } = await fixture()
    const workspaceRoot = join(directory, 'legacy-project')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'WORKBUDDY.md'), '# Legacy Instructions\n', 'utf8')

    const rules = await pipeline.loadWorkspaceRules(
      { id: 'run-3' },
      { id: 'ws-3', root_path: workspaceRoot, rules: '' },
    )

    expect(rules).toHaveLength(1)
    expect(rules[0]!.source).toBe('WORKBUDDY.md')
    expect(rules[0]!.content).toContain('# Legacy Instructions')
  })

  it('preloads skill instructions when run prompt starts with /skill-name', async () => {
    const { directory } = await fixture()
    const skillDir = join(directory, 'skills', 'codebase-design')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: codebase-design
description: Design deep modules.
---
# Deep Modules Instructions
Follow the glossary.
`, 'utf8')

    const database = {
      audit: vi.fn(),
      getSetting: vi.fn().mockReturnValue(''),
      listSkills: vi.fn().mockReturnValue([
        { id: 'skill-1', name: 'codebase-design', description: 'Design deep modules.', path: skillDir, enabled: true },
      ]),
      listArtifacts: vi.fn().mockReturnValue([]),
      listMemory: vi.fn().mockReturnValue([]),
      listContextCheckpoints: vi.fn().mockReturnValue([]),
      listMcpServers: vi.fn().mockReturnValue([]),
      listToolReceiptsForModel: vi.fn().mockReturnValue([]),
      getArtifact: vi.fn(),
    } as any
    const artifacts = {} as any
    const pipeline = new RunPreparationPipeline(database, artifacts, vi.fn())

    const result = await pipeline.prepare({
      run: { id: 'run-slash', prompt: '/codebase-design 优化架构设计', accessMode: 'approval', permissionMode: 'approval' },
      profile: { id: 'test', name: 'Test', provider: 'deepseek', modelId: 'v3', capabilities: { contextWindow: 64000 } } as any,
      workspace: { id: 'ws-1', root_path: directory, rules: '' },
      effectivePrompt: '/codebase-design 优化架构设计',
    })

    expect(result.systemPrompt).toContain('# Deep Modules Instructions')
    expect(result.systemPrompt).toContain('Follow the glossary.')
  })

  it('preloads workspace file content when prompt contains @path/to/file mention', async () => {
    const { directory } = await fixture()
    const srcDir = join(directory, 'src')
    await mkdir(srcDir, { recursive: true })
    const mainTs = join(srcDir, 'main.ts')
    await writeFile(mainTs, 'export const answer = 42\nconsole.log(answer)\n', 'utf8')

    const database = {
      audit: vi.fn(),
      getSetting: vi.fn().mockReturnValue(''),
      listSkills: vi.fn().mockReturnValue([]),
      listArtifacts: vi.fn().mockReturnValue([]),
      listMemory: vi.fn().mockReturnValue([]),
      listContextCheckpoints: vi.fn().mockReturnValue([]),
      listMcpServers: vi.fn().mockReturnValue([]),
      listToolReceiptsForModel: vi.fn().mockReturnValue([]),
      getArtifact: vi.fn(),
    } as any
    const artifacts = {} as any
    const pipeline = new RunPreparationPipeline(database, artifacts, vi.fn())

    const result = await pipeline.prepare({
      run: { id: 'run-at', prompt: '请帮我检查 @src/main.ts 的实现', accessMode: 'approval', permissionMode: 'approval' },
      profile: { id: 'test', name: 'Test', provider: 'deepseek', modelId: 'v3', capabilities: { contextWindow: 64000 } } as any,
      workspace: { id: 'ws-1', root_path: directory, rules: '' },
      effectivePrompt: '请帮我检查 @src/main.ts 的实现',
    })

    expect(result.systemPrompt).toContain('src/main.ts')
    expect(result.systemPrompt).toContain('export const answer = 42')
  })
})
