/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Channel id -> human-readable label conversion.
 *  Used as a fallback when no explicit channel descriptor has been registered.
 *--------------------------------------------------------------------------------------------*/

const KNOWN_LABELS: Record<string, string> = {
  main: 'Main',
  console: 'Console',
  renderer: 'Renderer',
  window: 'Window',
  workspace: 'Workspace',
  fileSystem: 'File System',
  fileWatcher: 'File Watcher',
  host: 'Host',
  command: 'Command',
  editor: 'Editor',
  editorGroups: 'Editor Groups',
  monaco: 'Monaco',
  action: 'Action',
}

/**
 * Best-effort humanization of an arbitrary channel id.
 * Used by Log Files listing when an explicit registration is missing.
 */
export function humanizeChannelId(channelId: string): string {
  const rendererMatch = /^renderer-(.+)$/.exec(channelId)
  if (rendererMatch?.[1]) return `Renderer ${rendererMatch[1]}`

  const direct = KNOWN_LABELS[channelId]
  if (direct) return direct

  return channelId
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}
