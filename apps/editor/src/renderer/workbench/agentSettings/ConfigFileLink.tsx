import { useCallback, type MouseEvent } from 'react'
import { IEditorResolverService, URI, localize, remoteFsPathToUri } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './AgentSettingsEditor.module.css'

export function getSiblingConfigPath(path: string, filename: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash === -1) return filename
  return `${path.slice(0, slash + 1)}${filename}`
}

export function ConfigFileLink({
  path,
  label = path,
  authority,
}: {
  readonly path: string
  readonly label?: string
  readonly authority?: string
}) {
  const editorResolver = useService(IEditorResolverService)

  const open = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      const uri = authority ? remoteFsPathToUri(path, authority) : URI.file(path)
      void editorResolver.openEditor(uri, { pinned: true })
    },
    [editorResolver, path, authority],
  )

  return (
    <button
      type="button"
      className={styles['pathLink']}
      onClick={open}
      data-tooltip={path}
      aria-label={localize('agentSettings.openConfigFile', 'Open {path}', { path })}
    >
      {label}
    </button>
  )
}
