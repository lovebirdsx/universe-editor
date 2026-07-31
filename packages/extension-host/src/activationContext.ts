import { AsyncLocalStorage } from 'node:async_hooks'
import type { IScannedExtension } from './extensionScanner.js'

const activationContext = new AsyncLocalStorage<IScannedExtension>()

export function runWithExtensionActivation<T>(extension: IScannedExtension, callback: () => T): T {
  return activationContext.run(extension, callback)
}

export function currentActivatingExtension(): IScannedExtension | undefined {
  return activationContext.getStore()
}
