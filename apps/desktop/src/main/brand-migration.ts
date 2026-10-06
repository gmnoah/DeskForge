export interface BrandMigrationResult {
  migrated: boolean
  compatibilityLinkCreated: boolean
}

/**
 * DeskForge does not import another product's application-support directory.
 * User data stays in the DeskForge userData path created by Electron.
 */
export async function migrateLegacyBrandDirectory(
  _appDataDirectory: string,
  _currentUserDataDirectory: string,
): Promise<BrandMigrationResult> {
  return { migrated: false, compatibilityLinkCreated: false }
}
