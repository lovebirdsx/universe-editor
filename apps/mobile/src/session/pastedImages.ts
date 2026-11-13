function isImageType(type: string): boolean {
  return type.toLowerCase().startsWith('image/')
}

/**
 * Image files carried by a paste event. WebKit sometimes exposes the picture
 * only through `files`, so items are tried first; the sources are never merged,
 * which also avoids duplicate attachments.
 */
export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (data === null) return []
  const fromItems: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null && (isImageType(file.type) || isImageType(item.type))) {
      fromItems.push(file)
    }
  }
  if (fromItems.length > 0) return fromItems
  return Array.from(data.files).filter((file) => isImageType(file.type))
}
