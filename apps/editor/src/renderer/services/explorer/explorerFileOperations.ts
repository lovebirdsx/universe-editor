import { URI } from '@universe-editor/platform'

const MAX_SAFE_SMALL_INTEGER = 9007199254740991

export function basenameOf(resource: URI): string {
  const segments = resource.path.split('/')
  return segments[segments.length - 1] ?? ''
}

export function targetInDirectory(destinationDir: URI, source: URI): URI {
  return URI.joinPath(destinationDir, basenameOf(source))
}

export function incrementFileName(name: string, isFolder: boolean): string {
  let namePrefix = name
  let extSuffix = ''
  if (!isFolder) {
    const extIndex = name.lastIndexOf('.')
    const hasExtension = extIndex > 0 || (extIndex === 0 && name.length > 1 && name[1] === '.')
    if (hasExtension) {
      extSuffix = name.slice(extIndex)
      namePrefix = name.slice(0, extIndex)
    }
  }

  const suffixRegex = /^(.+ copy)( \d+)?$/
  if (suffixRegex.test(namePrefix)) {
    return (
      namePrefix.replace(suffixRegex, (_match, prefix: string, rawNumber?: string) => {
        const number = rawNumber ? Number.parseInt(rawNumber.trim(), 10) : 1
        if (number === 0) return prefix
        return number < MAX_SAFE_SMALL_INTEGER
          ? `${prefix} ${number + 1}`
          : `${prefix}${rawNumber} copy`
      }) + extSuffix
    )
  }

  return `${namePrefix} copy${extSuffix}`
}
