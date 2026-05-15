import { type ComponentType } from 'react'
import { EditorRegistry, IEditorService } from '@universe-editor/platform'
import type { IEditorInput } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import styles from './EditorArea.module.css'

/** Registry of React components keyed by IEditorProvider.componentKey. */
export const editorComponentMap = new Map<string, ComponentType<{ input: IEditorInput }>>()

// Register built-in welcome editor
editorComponentMap.set('welcome', WelcomeEditor)

function WelcomeEditor(_props: { input: IEditorInput }) {
  return (
    <div className={styles['welcome']}>
      <h1>Universe Editor</h1>
      <p>A VSCode-paradigm game content editor.</p>
      <ul className={styles['shortcutList']}>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+Shift+P</kbd>
          <span>Open Command Palette</span>
        </li>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+`</kbd>
          <span>Toggle Output Panel</span>
        </li>
      </ul>
    </div>
  )
}

function EditorTab({
  input,
  isActive,
  onActivate,
  onClose,
}: {
  input: IEditorInput
  isActive: boolean
  onActivate: () => void
  onClose: () => void
}) {
  return (
    <div
      className={`${styles['tab']} ${isActive ? styles['active'] : ''}`}
      onClick={onActivate}
      role="tab"
      aria-selected={isActive}
    >
      {input.isDirty && <span className={styles['dirtyDot']} title="Unsaved changes" />}
      <span className={styles['tabLabel']}>{input.label}</span>
      <button
        className={styles['closeBtn']}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${input.label}`}
      >
        ×
      </button>
    </div>
  )
}

export function EditorArea() {
  const editorService = useService(IEditorService)
  const openEditors = useObservable(editorService.openEditors)
  const activeEditor = useObservable(editorService.activeEditor)

  const renderContent = () => {
    if (!activeEditor) {
      return (
        <WelcomeEditor
          input={{ id: '_welcome', type: 'welcome', label: 'Welcome', isDirty: false }}
        />
      )
    }
    const provider = EditorRegistry.getProvider(activeEditor.type)
    if (!provider) {
      return (
        <div className={styles['welcome']}>
          <p>No editor provider registered for type: {activeEditor.type}</p>
        </div>
      )
    }
    const Component = editorComponentMap.get(provider.componentKey)
    if (!Component) {
      return (
        <div className={styles['welcome']}>
          <p>Editor component not found: {provider.componentKey}</p>
        </div>
      )
    }
    return <Component input={activeEditor} />
  }

  return (
    <div className={styles['editorArea']}>
      {openEditors.length > 0 && (
        <div className={styles['tabBar']} role="tablist">
          {openEditors.map((e) => (
            <EditorTab
              key={e.id}
              input={e}
              isActive={activeEditor?.id === e.id}
              onActivate={() => editorService.openEditor(e)}
              onClose={() => editorService.closeEditor(e.id)}
            />
          ))}
        </div>
      )}
      <div className={styles['editorContent']}>{renderContent()}</div>
    </div>
  )
}
