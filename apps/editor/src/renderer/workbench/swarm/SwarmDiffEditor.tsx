/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmDiffEditor — a Monaco side-by-side diff for one file in a Swarm review,
 *  with GitHub-PR-style inline comments layered on via SwarmInlineCommentController.
 *
 *  Both sides come from p4 snapshots at their version's backing change (passed on
 *  the SwarmDiffEditorInput), so line numbers match Swarm's inline-comment
 *  coordinates. Comments are loaded / posted through ICommandService, and the
 *  controller anchors them by (side, line) → Swarm context.left/rightLine.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  type IEditorInput,
  localize,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmAddCommentRequest,
  type SwarmCommentDto,
} from '@universe-editor/extensions-common'
import { useService } from '../useService.js'
import type { monaco } from '../editor/monaco/MonacoLoader.js'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import { buildBridgedEditorOptions } from '../editor/monaco/editorOptionsFromConfig.js'
import { languageForResource } from '../files/resourceLanguage.js'
import { diffModelUri } from '../editor/diffModelUri.js'
import { wireDiffEditorViewState } from '../editor/diffEditorViewState.js'
import { SwarmDiffEditorInput } from '../../services/editor/SwarmDiffEditorInput.js'
import { DiffEditorRegistry } from '../../services/editor/DiffEditorRegistry.js'
import { acquireDiffModels, storeDiffModels } from '../../services/editor/diffModelCache.js'
import { recordPerfPhase, recordPerfPhaseAsync } from '../../services/performance/perfPhases.js'
import { syncEditorFocusContext } from '../../services/editor/editorFocus.js'
import { EditorGroupContext } from '../editor/EditorGroupContext.js'
import {
  SwarmInlineCommentController,
  type SwarmInlineSubmit,
} from './SwarmInlineCommentController.js'
import styles from './SwarmDiffEditor.module.css'

/** When off (default) the diff shows code only — no inline comment threads / affordance. */
const INLINE_COMMENTS_CONFIG_KEY = 'perforce.swarm.inlineComments.enabled'

export function SwarmDiffEditor({ input }: { input: IEditorInput }) {
  const diffInput = input as SwarmDiffEditorInput
  const commands = useService(ICommandService)
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const controllerRef = useRef<SwarmInlineCommentController | null>(null)
  const [monacoNs, setMonacoNs] = useState<typeof monaco | null>(null)
  const [inlineCommentsEnabled, setInlineCommentsEnabled] = useState(
    () => configService.get<boolean>(INLINE_COMMENTS_CONFIG_KEY) ?? false,
  )

  const { reviewId } = diffInput.context

  const loadComments = useCallback(() => {
    void commands
      .executeCommand<SwarmCommentDto[]>(SwarmCommands.listComments, { reviewId })
      .then((all) => {
        // Only comments anchored to this file.
        const forFile = (all ?? []).filter((c) => c.context?.file === diffInput.context.depotFile)
        controllerRef.current?.setComments(forFile)
      })
      .catch(() => {
        /* leave threads as-is */
      })
  }, [commands, reviewId, diffInput.context.depotFile])

  const postComment = useCallback(
    async (submit: SwarmInlineSubmit): Promise<void> => {
      const version =
        submit.side === 'right' ? diffInput.context.rightVersion : diffInput.context.leftVersion
      const req: SwarmAddCommentRequest = {
        reviewId,
        body: submit.body,
        ...(submit.asTask ? { asTask: true } : {}),
        context: {
          file: diffInput.context.depotFile,
          ...(submit.side === 'right' ? { rightLine: submit.line } : { leftLine: submit.line }),
          ...(version !== null ? { version } : {}),
        },
        content: submit.content,
      }
      await commands.executeCommand(SwarmCommands.addComment, req)
      loadComments()
    },
    [commands, reviewId, diffInput.context, loadComments],
  )

  const setTaskState = useCallback(
    async (commentId: string, taskState: string): Promise<void> => {
      await commands.executeCommand(SwarmCommands.setTaskState, {
        reviewId,
        commentId,
        taskState,
      })
      loadComments()
    },
    [commands, loadComments, reviewId],
  )

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
    const sub = configService.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(INLINE_COMMENTS_CONFIG_KEY)) {
        setInlineCommentsEnabled(configService.get<boolean>(INLINE_COMMENTS_CONFIG_KEY) ?? false)
      }
    })
    return () => sub.dispose()
  }, [configService])

  // Create the diff editor + inline-comment controller, set models.
  useEffect(() => {
    if (!monacoNs || !containerRef.current) return
    const ed = monacoNs.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      editContext: true,
      ...buildBridgedEditorOptions(configService),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      glyphMargin: true,
      scrollBeyondLastLine: false,
    })
    diffEditorRef.current = ed
    const hoverGuard = MonacoLoader.trackEditorDispose(ed)

    // Reuse the previous mount's models when their text still matches the
    // input's (tab reopen / switch-back) — skips two createModel + tokenize
    // passes. A reopened pending version whose shelf changed fails the text
    // check inside acquire and falls through to a fresh build.
    const cached = acquireDiffModels(diffInput.id, {
      originalText: diffInput.originalContent,
      modifiedText: diffInput.modifiedContent,
    })
    let original: monaco.editor.ITextModel
    let modified: monaco.editor.ITextModel
    if (cached) {
      recordPerfPhase('swarmDiffEditor.modelCacheHit', () => {})
      original = cached.original
      modified = cached.modified
    } else {
      const language = languageForResource(diffInput.fileUri)
      // The qualifier carries this comparison's identity so two diffs of the
      // same file at different versions never collide on a model URI.
      const qualifier = encodeURIComponent(diffInput.id)
      const built = recordPerfPhase('swarmDiffEditor.createModels', () => ({
        original: monacoNs.editor.createModel(
          diffInput.originalContent,
          language,
          monacoNs.Uri.parse(diffModelUri(diffInput.fileUri, 'original', qualifier).toString()),
        ),
        modified: monacoNs.editor.createModel(
          diffInput.modifiedContent,
          language,
          monacoNs.Uri.parse(diffModelUri(diffInput.fileUri, 'modified', qualifier).toString()),
        ),
      }))
      original = built.original
      modified = built.modified
    }
    recordPerfPhase('swarmDiffEditor.setModel', () => {
      ed.setModel({ original, modified })
    })
    originalModelRef.current = original
    modifiedModelRef.current = modified
    // Wall time from setModel to Monaco's first completed diff computation.
    void recordPerfPhaseAsync(
      'swarmDiffEditor.firstDiffCompute',
      () =>
        new Promise<void>((resolve) => {
          const listener = ed.onDidUpdateDiff(() => {
            listener.dispose()
            resolve()
          })
        }),
    )
    DiffEditorRegistry.register(diffInput, ed, group?.id)

    const activeGroup = groupsService.activeGroup
    if (activeGroup.activeEditor === diffInput && !activeGroup.lastActivationPreservedFocus) {
      ed.focus()
      syncEditorFocusContext(contextKeyService)
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    }

    // Persist / restore scroll + cursor across tab switches — same mechanism as
    // the generic DiffEditor. It also handles the first-change reveal on a fresh
    // open. No shared cursor: swarm sides are depot snapshots that drift from the
    // local working copy, so a cross-editor cursor would land on the wrong line.
    const viewState = wireDiffEditorViewState(ed, {
      groupId: group?.id,
      resourceKey: diffInput.resource.toString(),
    })

    const controller = inlineCommentsEnabled
      ? new SwarmInlineCommentController(ed, {
          onSubmit: postComment,
          onReply: postComment,
          onSetTaskState: setTaskState,
        })
      : null
    controllerRef.current = controller
    if (controller) loadComments()

    return () => {
      controller?.dispose()
      controllerRef.current = null
      // Dispose before ed.dispose() so the final view-state flush reads a live editor.
      viewState.dispose()
      DiffEditorRegistry.unregister(diffInput, ed)
      ed.setModel(null)
      // Hand the models to the LRU instead of disposing — a reopen of this same
      // diff (tab close/reopen, switch-back) then skips createModel + tokenize.
      storeDiffModels(diffInput.id, original, modified)
      originalModelRef.current = null
      modifiedModelRef.current = null
      hoverGuard.dispose()
      ed.dispose()
      diffEditorRef.current = null
    }
  }, [
    monacoNs,
    diffInput,
    configService,
    inlineCommentsEnabled,
    postComment,
    setTaskState,
    loadComments,
    group,
    groupsService,
    contextKeyService,
  ])

  // Refresh both sides in place when the input's content changes (a re-shelved
  // pending version re-opened onto the same tab). The diffInput instance is
  // mutated via updateFrom, so the set-model effect above won't re-run — update
  // the live models directly (mirrors the generic DiffEditor).
  useEffect(() => {
    const disposable = diffInput.onDidChangeContent(() => {
      if (
        originalModelRef.current &&
        originalModelRef.current.getValue() !== diffInput.originalContent
      ) {
        originalModelRef.current.setValue(diffInput.originalContent)
      }
      if (
        modifiedModelRef.current &&
        modifiedModelRef.current.getValue() !== diffInput.modifiedContent
      ) {
        modifiedModelRef.current.setValue(diffInput.modifiedContent)
      }
    })
    return () => disposable.dispose()
  }, [diffInput])

  if (!monacoNs) {
    return (
      <div className={styles['diffEditor']} data-testid="swarm-diff-editor">
        <div className={styles['loading']}>{localize('editor.loading', 'Loading editor…')}</div>
      </div>
    )
  }

  return (
    <div className={styles['diffEditor']} data-testid="swarm-diff-editor">
      <div ref={containerRef} className={styles['monacoContainer']} />
    </div>
  )
}
