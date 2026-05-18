import type { URI } from '@universe-editor/platform'

export function basenameOfPath(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

export function basenameOfResource(resource: URI): string {
  return basenameOfPath(resource.fsPath)
}

export function dirnameOfResource(resource: URI): string {
  const path = resource.fsPath
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? '' : path.slice(0, slash)
}

export function extensionOfBasename(name: string): string | null {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : name.slice(dot).toLowerCase()
}
