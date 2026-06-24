import { useCallback, type MouseEvent } from 'react'
import { IEditorResolverService, URI, localize } from '@universe-editor/platform'
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
}: {
  readonly path: string
  readonly label?: string
}) {
  const editorResolver = useService(IEditorResolverService)

  const open = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      void editorResolver.openEditor(URI.file(path), { pinned: true })
    },
    [editorResolver, path],
  )

  return (
    <button
      type="button"
      className={styles['pathLink']}
      onClick={open}
      title={path}
      aria-label={localize('agentSettings.openConfigFile', 'Open {path}', { path })}
    >
      {label}
    </button>
  )
}
