export * from '@earendil-works/pi-ai'

export function streamSimple(): never {
  throw new Error('DeskForge uses custom streamFn; pi-ai compat streamSimple is not used')
}
