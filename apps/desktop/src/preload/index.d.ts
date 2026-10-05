import type { DesktopApi } from '@deskforge/contracts'

declare global {
  interface Window {
    deskforge: DesktopApi
  }
}

export {}
