import { describe, expect, it } from 'vitest'
import { migrateLegacyBrandDirectory } from './brand-migration'

describe('brand data migration', () => {
  it('does not move another product directory into DeskForge', async () => {
    await expect(migrateLegacyBrandDirectory('/tmp/unused-app-data', '/tmp/unused-deskforge')).resolves.toEqual({
      migrated: false,
      compatibilityLinkCreated: false,
    })
  })
})
