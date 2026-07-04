/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MergeEditor — VSCode-style 3-way merge editor.
 *
 *  Layout: two read-only diff panes on top (base ↔ current and base ↔ incoming),
 *  and one editable Result pane below seeded with the working-tree content (git
 *  conflict markers intact). The Result pane reuses InlineConflictController so
 *  the per-conflict Accept buttons behave identically to the inline experience;
 *  resolving edits the Result model and the live unresolved count drives the
 *  toolbar. "Complete Merge" writes the file and stages it via MergeEditorInput.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef, useState } from 'react'
import {
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { languageForResource } from '../files/resourceLanguage.js'
import { MergeEditorInput } from '../../services/editor/MergeEditorInput.js'
import { MergeEditorRegistry } from '../../services/editor/MergeEditorRegistry.js'
import { InlineConflictController } from '../scm/mergeConflict/inlineConflictController.js'
import { syncEditorFocusContext } from '../../services/editor/editorFocus.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import styles from './MergeEditor.module.css'

function editorTheme(config: IConfigurationService): 'output-light' | 'output-dark' {
  return config.get<string>('workbench.colorTheme') === 'light' ? 'output-light' : 'output-dark'
}

function fontSize(config: IConfigurationService): number {
  const raw = config.get<number>('editor.fontSize')
  return typeof raw === 'number' ? raw : 14
}

export function MergeEditor({ input }: { input: IEditorInput }) {
  const mergeInput = input as MergeEditorInput
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)

  const currentRef = useRef<HTMLDivElement | null>(null)
  const incomingRef = useRef<HTMLDivElement | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)
  const [monacoNs, setMonacoNs] = useState<typeof monaco | null>(null)
  const [unresolved, setUnresolved] = useState(0)

  useEffect(() => {
    let cancelled = false
    void MonacoLoader.ensureInitialized().then((m) => {
      if (!cancelled) setMonacoNs(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!monacoNs) return
    const c = mergeInput.contents
    const language = languageForResource(mergeInput.fileUri)
    const theme = editorTheme(configService)
    const size = fontSize(configService)
    const models: monaco.editor.ITextModel[] = []

    const makeModel = (value: string, scheme: string): monaco.editor.ITextModel => {
      const model = monacoNs.editor.createModel(
        value,
        language,
        monacoNs.Uri.parse(mergeInput.fileUri.with({ scheme }).toString()),
      )
      models.push(model)
      return model
    }

    // Top-left: base ↔ current. Top-right: base ↔ incoming. Both read-only.
    const baseModel = makeModel(c.base, 'merge-base')
    const baseModel2 = makeModel(c.base, 'merge-base2')

    const currentDiff = monacoNs.editor.createDiffEditor(currentRef.current!, {
      theme,
      fontSize: size,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
    })
    currentDiff.setModel({ original: baseModel, modified: makeModel(c.current, 'merge-current') })

    const incomingDiff = monacoNs.editor.createDiffEditor(incomingRef.current!, {
      theme,
      fontSize: size,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
    })
    incomingDiff.setModel({
      original: baseModel2,
      modified: makeModel(c.incoming, 'merge-incoming'),
    })

    // Bottom: editable Result pane seeded with the working-tree (marker) content.
    const resultModel = makeModel(c.merged, 'merge-result')
    const resultEditor = monacoNs.editor.create(resultRef.current!, {
      model: resultModel,
      theme,
      fontSize: size,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    })

    const controller = new InlineConflictController(resultEditor)
    setUnresolved(controller.count)
    const countSub = controller.onDidChangeCount(setUnresolved)
    const contentSub = resultModel.onDidChangeContent(() => {
      mergeInput.setResult(resultModel.getValue())
    })

    // Bridge the editable Result pane's text focus → global `editorTextFocus`,
    // like FileEditor. With editContext: true (Monaco 0.55 default) the focus
    // host is not DOM-editable, so the global keybinding handler relies on this
    // key to reserve native editing keys (Delete/Backspace) for the editor —
    // without it a global `delete` binding (delete-file) swallows Delete in the
    // Result pane. See editor-text-focus-stuck-swallows-keys.
    const textFocusSub = resultEditor.onDidFocusEditorText(() =>
      contextKeyService.set('editorTextFocus', true),
    )
    const textBlurSub = resultEditor.onDidBlurEditorText(() =>
      contextKeyService.set('editorTextFocus', false),
    )

    MergeEditorRegistry.register(mergeInput, resultEditor, group?.id)

    const activeGroup = groupsService.activeGroup
    if (activeGroup.activeEditor === mergeInput && !activeGroup.lastActivationPreservedFocus) {
      resultEditor.focus()
    }

    return () => {
      countSub.dispose()
      contentSub.dispose()
      textFocusSub.dispose()
      textBlurSub.dispose()
      controller.dispose()
      MergeEditorRegistry.unregister(mergeInput, resultEditor)
      currentDiff.dispose()
      incomingDiff.dispose()
      resultEditor.dispose()
      for (const m of models) m.dispose()
      // Blur may not fire before dispose; reconcile editorTextFocus against
      // actual DOM focus so it never lingers true past unmount.
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    }
  }, [monacoNs, mergeInput, group, configService, groupsService, contextKeyService])

  const complete = () => {
    void (async () => {
      const saved = await mergeInput.save?.()
      if (saved) groupsService.activeGroup.closeEditor(mergeInput)
    })()
  }

  if (!monacoNs) {
    return (
      <div className={styles['mergeEditor']} data-testid="merge-editor">
        <div className={styles['loading']}>
          {localize('mergeEditor.loading', 'Loading editor…')}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['mergeEditor']} data-testid="merge-editor">
      <div className={styles['toolbar']}>
        <span className={styles['status']}>
          {unresolved > 0
            ? localize('mergeEditor.unresolved', '{count} conflict(s) remaining', {
                count: unresolved,
              })
            : localize('mergeEditor.allResolved', 'All conflicts resolved')}
        </span>
        <button
          className={styles['completeButton']}
          onClick={complete}
          disabled={unresolved > 0}
          data-testid="merge-complete"
        >
          {localize('mergeEditor.complete', 'Complete Merge')}
        </button>
      </div>
      <div className={styles['inputs']}>
        <div className={styles['pane']}>
          <div className={styles['paneTitle']}>
            {mergeInput.contents.currentLabel || localize('mergeEditor.current', 'Current Change')}
          </div>
          <div ref={currentRef} className={styles['paneBody']} />
        </div>
        <div className={styles['pane']}>
          <div className={styles['paneTitle']}>
            {mergeInput.contents.incomingLabel ||
              localize('mergeEditor.incoming', 'Incoming Change')}
          </div>
          <div ref={incomingRef} className={styles['paneBody']} />
        </div>
      </div>
      <div className={styles['result']}>
        <div className={styles['paneTitle']}>{localize('mergeEditor.result', 'Result')}</div>
        <div ref={resultRef} className={styles['paneBody']} />
      </div>
    </div>
  )
}
