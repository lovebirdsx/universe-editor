import { basename, dirname, type URI } from '@universe-editor/platform'

export function basenameOfPath(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

/** Last path segment of a resource, scheme-agnostic (`uri.path`, not `.fsPath`). */
export function basenameOfResource(resource: URI): string {
  return basename(resource.path)
}

/** Directory portion of a resource, scheme-agnostic (`uri.path`, not `.fsPath`). */
export function dirnameOfResource(resource: URI): string {
  return dirname(resource.path)
}

export function extensionOfBasename(name: string): string | null {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : name.slice(dot).toLowerCase()
}
