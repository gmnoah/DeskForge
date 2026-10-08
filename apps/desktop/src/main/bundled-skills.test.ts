import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BUNDLED_SKILL_NAMES } from './bundled-skills'
import { inspectSkillDirectory } from './skill-import'

const resources = fileURLToPath(new URL('../../resources/skills', import.meta.url))
const examples = fileURLToPath(new URL('../../../../skills/examples', import.meta.url))

describe('bundled skills', () => {
  it('ships every listed skill and nothing unlisted', async () => {
    const directories = (await readdir(resources, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(directories.sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
  })

  it.each(BUNDLED_SKILL_NAMES)('%s passes strict import validation and stays offline', async (name) => {
    const inspection = await inspectSkillDirectory(join(resources, name))
    expect(inspection.parsed.name).toBe(name)
    expect(inspection.parsed.description.length).toBeGreaterThan(10)
    expect(inspection.parsed.version).toMatch(/^\d+\.\d+\.\d+$/)
    const capabilities = inspection.parsed.permissions.map((permission) => permission.capability)
    expect(capabilities.length).toBeGreaterThan(0)
    expect(capabilities).not.toContain('network')
    expect(capabilities).not.toContain('browser')
    expect(capabilities).not.toContain('mcp')
    expect(inspection.files.some((file) => file.kind === 'script')).toBe(false)
  })

  it('keeps skills/examples identical to the bundled copies', async () => {
    const getEntries = async (baseDir: string) => {
      const dirents = await readdir(baseDir, { recursive: true, withFileTypes: true })
      return dirents.map((dirent) => {
        const parent = dirent.parentPath ? dirent.parentPath.slice(baseDir.length).replace(/^[/\\]/, '') : ''
        return {
          relPath: parent ? join(parent, dirent.name) : dirent.name,
          isFile: dirent.isFile(),
        }
      }).sort((a, b) => a.relPath.localeCompare(b.relPath))
    }

    const [bundledEntries, exampleEntries] = await Promise.all([getEntries(resources), getEntries(examples)])
    expect(exampleEntries.map((e) => e.relPath)).toEqual(bundledEntries.map((e) => e.relPath))

    for (const entry of bundledEntries) {
      if (entry.isFile) {
        const [example, bundled] = await Promise.all([
          readFile(join(examples, entry.relPath), 'utf8'),
          readFile(join(resources, entry.relPath), 'utf8'),
        ])
        expect(example, entry.relPath).toBe(bundled)
      }
    }
  })
})
