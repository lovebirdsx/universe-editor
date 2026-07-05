/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptInput — the textarea plus two inline popovers (slash-command +
 *  @-mention) for the agent chat. Owns local state (text, caret-tracked
 *  popover index/dismissal, recorded mentions); writes go to the session
 *  via `sendPrompt` / `cancelTurn`. Kept out of ChatBody so the keyboard
 *  wiring can be exercised in unit tests without standing up the DI graph.
 *
 *  Mentions strategy: when the user picks a file we record the entry's
 *  display name → URI in local state. On submit we hand the text + the
 *  mention list to `sendPrompt`; the service serializes any `@<name>` that
 *  matches a recorded mention into a `resource_link` AcpContentBlock and
 *  leaves the rest as text. If the user edits/deletes the literal `@<name>`
 *  before sending, the link silently disappears — by design. Both the text
 *  and the recorded mentions are persisted per session via AcpPromptDraftCache,
 *  so switching tabs / sessions and coming back restores the draft with its
 *  mentions intact.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react'
import {
  IConfigurationService,
  IContextKeyService,
  IFileDialogService,
  IFileSearchService,
  IFileService,
  IHostService,
  IWorkspaceService,
  IDialogService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  Severity,
  generateUuid,
  localize,
} from '@universe-editor/platform'
import { dragContainsResources } from '@universe-editor/workbench-ui'
import { readDroppedResources, toMentionName } from '../../services/dnd/resourceDropTransfer.js'
import { AlignJustify, FoldVertical, UnfoldVertical, type LucideIcon } from 'lucide-react'
import type { CollapseMode } from '../../services/acp/acpChatViewStateCache.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, SelectionContext } from '../../services/acp/acpSessionService.js'
import {
  blobToPromptImage,
  bytesToPromptImage,
  mimeTypeForFileName,
  validateImage,
  type ImageLimits,
  type ImageRejectReason,
  type PromptImage,
} from '../../services/acp/promptImage.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { URI } from '@universe-editor/platform'
import type { WidgetHandle } from './ChatBody.js'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  detectFilePickerTrigger,
  extractMentionQuery,
  type ActiveMentionQuery,
  type FilePickerTriggerKind,
} from '../../services/acp/promptMentions.js'
import { extractHashQuery, type ActiveHashQuery } from '../../services/acp/promptContextRef.js'
import {
  CommitContextProvider,
  ScmChangeContextProvider,
  WorkspaceSymbolContextProvider,
  OpenEditorContextProvider,
  DocsContextProvider,
  type ContextSuggestionItem,
} from '../../services/acp/contextSuggestions.js'
import { CommitRefPicker } from '../../services/acp/commitRefPicker.js'
import { mentionEntryToRef, suggestionItemToRef } from '../../services/acp/promptRef.js'
import {
  collectActiveSelectionContexts,
  formatSelectionLabel,
} from '../../services/acp/promptContext.js'
import {
  filterMentionFiles,
  loadWorkspaceFiles,
  type MentionFileEntry,
} from '../../services/acp/mentionFileSearch.js'
import { MentionPopover } from './MentionPopover.js'
import { ContextPopover, type ContextPopoverEntry } from './ContextPopover.js'
import { SelectionContextChips } from './SelectionContextChips.js'
import { PromptImageChips } from './PromptImageChips.js'
import {
  PromptMonacoEditor,
  type PromptEditorHandle,
  type PromptChangeSource,
  type PromptChangeKind,
} from './PromptMonacoEditor.js'
import { SlashCommandPopover, filterCommands } from './SlashCommandPopover.js'
import { PromptHistoryPopover } from './PromptHistoryPopover.js'
import { ConfigOptionsBar } from './ConfigOptionsBar.js'
import { SendButton } from './SendButton.js'
import { StopButton } from './StopButton.js'
import { AcpPromptDraftCache } from '../../services/acp/acpPromptDraftCache.js'
import { AcpPromptContextInbox } from '../../services/acp/acpPromptContextInbox.js'
import { AcpPromptTextInbox } from '../../services/acp/acpPromptTextInbox.js'
import { IAcpPromptHistoryService } from '../../services/acp/acpPromptHistoryService.js'
import { useSessionTimer, formatRunningTime } from './useSessionTimer.js'
import { UsageIndicator } from './UsageIndicator.js'
import { SessionCostIndicator } from './SessionCostIndicator.js'
import styles from './agents.module.css'

// Snapshot of the live popover state + accept callbacks, kept in a ref so the
// WidgetHandle popover methods (bound once) act on current data when a
// suggestion command fires.
interface PopoverHandleState {
  slashOpen: boolean
  mentionOpen: boolean
  hashOpen: boolean
  historyOpen: boolean
  slashMatches: readonly AvailableCommand[]
  mentionMatches: readonly MentionFileEntry[]
  hashMatches: readonly ContextPopoverEntry[]
  slashIndex: number
  mentionIndex: number
  hashIndex: number
  historyIndex: number
  historyEntries: readonly string[]
  mentionQuery: ActiveMentionQuery | null
  hashQuery: ActiveHashQuery | null
  acceptSlash: (cmd: AvailableCommand) => void
  acceptMention: (entry: MentionFileEntry, q: ActiveMentionQuery) => void
  acceptContextRef: (entry: ContextPopoverEntry, q: ActiveHashQuery) => void
  acceptHistory: () => void
  restoreHistoryDraft: () => void
}

export function PromptInput({
  session,
  autoFocus = false,
  handleRef,
  onPopoverOpenChange,
}: {
  session: IAcpSession
  autoFocus?: boolean
  handleRef?: MutableRefObject<WidgetHandle>
  onPopoverOpenChange?: (open: boolean) => void
}) {
  const [text, setText] = useState(() => AcpPromptDraftCache.load(session.id)?.text ?? '')
  const [caret, setCaret] = useState(() => AcpPromptDraftCache.load(session.id)?.caret ?? 0)
  // Seed the (uncontrolled) Monaco editor with the restored draft on mount.
  // Captured once so a remount of the same session restores its draft text +
  // reference pills.
  const initialDraftRef = useRef({
    text,
    caret,
    refs: AcpPromptDraftCache.load(session.id)?.refs ?? [],
  })
  const [dropActive, setDropActive] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [hashIndex, setHashIndex] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(0)
  // User-driven dismissal of the popover for the current token. Reset
  // every time the token disappears so the popover comes back when the
  // user starts a fresh command/mention.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [hashDismissed, setHashDismissed] = useState(false)
  const [contexts, setContexts] = useState<readonly SelectionContext[]>(
    () => AcpPromptDraftCache.load(session.id)?.contexts ?? [],
  )
  const [images, setImages] = useState<readonly PromptImage[]>(
    () => AcpPromptDraftCache.load(session.id)?.images ?? [],
  )
  const [files, setFiles] = useState<readonly MentionFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [hashSuggestions, setHashSuggestions] = useState<{
    readonly symbol: readonly ContextSuggestionItem[]
    readonly scmChange: readonly ContextSuggestionItem[]
    readonly openEditor: readonly ContextSuggestionItem[]
    readonly docs: readonly ContextSuggestionItem[]
    readonly commit: readonly ContextSuggestionItem[]
  }>({ symbol: [], scmChange: [], openEditor: [], docs: [], commit: [] })
  const [hashLoading, setHashLoading] = useState(false)
  const editorHandleRef = useRef<PromptEditorHandle | null>(null)
  // The React-owned host div wrapping the Monaco editor. Paste listens here
  // (outside Monaco's editContext DOM — see onPromptPaste).
  const dropHostRef = useRef<HTMLDivElement | null>(null)
  // Saves the in-progress draft text when the user enters history navigation mode,
  // so Escape / Down-past-end restores it.
  const historyDraftRef = useRef('')
  // Latest popover state + accept callbacks, read by the WidgetHandle methods
  // (bound once) when a suggestion command fires. Refreshed every render.
  const popoverStateRef = useRef<PopoverHandleState | null>(null)
  // Guards the hash-suggestions fetch effect against out-of-order async
  // resolution (a slow symbol query landing after a newer one started).
  const hashSeqRef = useRef(0)
  const contextProvidersRef = useRef<{
    readonly symbol: WorkspaceSymbolContextProvider
    readonly scmChange: ScmChangeContextProvider
    readonly openEditor: OpenEditorContextProvider
    readonly docs: DocsContextProvider
    readonly commit: CommitContextProvider
  } | null>(null)

  const fileSearch = useService(IFileSearchService)
  const workspace = useService(IWorkspaceService)
  const exclude = useService(IExcludeService)
  const config = useService(IConfigurationService)
  const dialogService = useService(IDialogService)
  const fileDialog = useService(IFileDialogService)
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const historyService = useService(IAcpPromptHistoryService)
  const notification = useService(INotificationService)
  const fileService = useService(IFileService)
  const contextKeyService = useService(IContextKeyService)
  const hostService = useService(IHostService)
  const workspaceRoot = workspace.current?.folder

  const status = useObservable(session.status)
  const commands = useObservable(session.availableCommands)
  const timeline = useObservable(session.timeline)
  const historyEntries = useObservable(historyService.entries)
  const imageSupported = useObservable(session.imageSupported)
  const running = status === 'running'
  const hasUserMessages = timeline.some(
    (item) => item.kind === 'message' && item.message.role === 'user',
  )
  const collapseMode = useObservable(session.collapseMode)
  const totalRunningMs = useSessionTimer(session)

  // Lazily instantiate the four `#`-context data sources on first use so
  // sessions that never type `#` pay no DI/construction cost.
  const ensureContextProviders = useCallback(() => {
    contextProvidersRef.current ??= {
      symbol: instantiation.createInstance(WorkspaceSymbolContextProvider),
      scmChange: instantiation.createInstance(ScmChangeContextProvider),
      openEditor: instantiation.createInstance(OpenEditorContextProvider),
      docs: instantiation.createInstance(DocsContextProvider),
      commit: instantiation.createInstance(CommitContextProvider),
    }
    return contextProvidersRef.current
  }, [instantiation])

  // Expose `focus()` plus the popover navigation methods to the AcpChatWidget
  // handle. The widget service routes the suggestion commands (Select Next/Prev,
  // Accept, Hide — gated on `acpPromptPopupVisible`) and Ctrl+Alt+I here without
  // a global event bus. The methods read `popoverStateRef` so they always act on
  // the live state without re-binding every render.
  useEffect(() => {
    if (!handleRef) return
    const ref = handleRef
    ref.current.focus = () => {
      const el = editorHandleRef.current
      if (!el) return false
      return el.focus()
    }
    ref.current.popoverSelectNext = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        // Down = newer entry. History is newest-first (index 0 = newest), so
        // "newer" decrements; stepping below the newest restores the draft the
        // user was typing before they opened history (shell/terminal convention).
        if (s.historyIndex > 0) {
          setHistoryIndex((i) => i - 1)
        } else {
          s.restoreHistoryDraft()
        }
        return
      }
      if (s.hashOpen && s.hashMatches.length > 0) {
        setHashIndex((i) => (i + 1) % s.hashMatches.length)
      } else if (s.mentionOpen && s.mentionMatches.length > 0) {
        setMentionIndex((i) => (i + 1) % s.mentionMatches.length)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        setSlashIndex((i) => (i + 1) % s.slashMatches.length)
      }
    }
    ref.current.popoverSelectPrev = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        // Up = older entry. Newest-first list, so "older" increments; clamp at
        // the oldest so repeated Up doesn't wrap back around to the newest.
        if (s.historyIndex < s.historyEntries.length - 1) {
          setHistoryIndex((i) => i + 1)
        }
        return
      }
      if (s.hashOpen && s.hashMatches.length > 0) {
        setHashIndex((i) => (i - 1 + s.hashMatches.length) % s.hashMatches.length)
      } else if (s.mentionOpen && s.mentionMatches.length > 0) {
        setMentionIndex((i) => (i - 1 + s.mentionMatches.length) % s.mentionMatches.length)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        setSlashIndex((i) => (i - 1 + s.slashMatches.length) % s.slashMatches.length)
      }
    }
    ref.current.popoverAccept = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        s.acceptHistory()
        return
      }
      if (s.hashOpen && s.hashQuery !== null && s.hashMatches.length > 0) {
        const target = s.hashMatches[s.hashIndex] ?? s.hashMatches[0]
        if (target) s.acceptContextRef(target, s.hashQuery)
      } else if (s.mentionOpen && s.mentionQuery !== null && s.mentionMatches.length > 0) {
        const target = s.mentionMatches[s.mentionIndex] ?? s.mentionMatches[0]
        if (target) s.acceptMention(target, s.mentionQuery)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        const target = s.slashMatches[s.slashIndex] ?? s.slashMatches[0]
        if (target) s.acceptSlash(target)
      }
    }
    ref.current.popoverHide = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        s.restoreHistoryDraft()
        return
      }
      if (s.hashOpen) setHashDismissed(true)
      else if (s.mentionOpen) setMentionDismissed(true)
      else if (s.slashOpen) setSlashDismissed(true)
    }
    return () => {
      ref.current.focus = () => false
      ref.current.popoverSelectNext = () => {}
      ref.current.popoverSelectPrev = () => {}
      ref.current.popoverAccept = () => {}
      ref.current.popoverHide = () => {}
    }
  }, [handleRef])

  // Auto-focus on session swap so the user can keep typing without clicking
  // the textarea. Skip the initial mount so we don't steal focus from a
  // button click that opened the panel.
  const prevSessionIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = session.id
    if (prev !== undefined && prev !== session.id) {
      editorHandleRef.current?.focus()
    }
  }, [session.id])

  // Close the history popover when switching sessions.
  useEffect(() => {
    setHistoryOpen(false)
  }, [session.id])

  // Initial-mount focus for callers that opt in (full-screen editor).
  // Sidebar leaves this false so opening the ChatPanel doesn't yank focus
  // from whatever the user just clicked.
  useEffect(() => {
    if (autoFocus) editorHandleRef.current?.focus()
  }, [autoFocus])

  // Drain any SelectionContexts the "Add Selection to Agent Chat" command
  // deposited for this session before its ChatBody mounted, and keep draining
  // while mounted (the command deposits then fires onDidDeposit). Keyed on the
  // local session id — same key the command deposits under.
  useEffect(() => {
    const pull = (): void => {
      const incoming = AcpPromptContextInbox.drain(session.id)
      if (incoming.length === 0) return
      setContexts((prev) => mergeContexts(prev, incoming))
      editorHandleRef.current?.focus()
    }
    pull()
    const sub = AcpPromptContextInbox.onDidDeposit((id) => {
      if (id === session.id) pull()
    })
    return () => sub.dispose()
  }, [session.id])

  // Drain any plain-text snippets a command (e.g. Git Graph's "Send to Agent
  // Chat") deposited for this session, appending them to the textarea and moving
  // the caret to the end. Mirrors the SelectionContext drain above.
  useEffect(() => {
    const pull = (): void => {
      const incoming = AcpPromptTextInbox.drain(session.id)
      if (incoming.length === 0) return
      const el = editorHandleRef.current
      const prev = el?.getText() ?? ''
      const joined = incoming.join('\n')
      const next = prev ? `${prev}\n${joined}` : joined
      el?.setText(next, next.length)
      requestAnimationFrame(() => el?.focus())
    }
    pull()
    const sub = AcpPromptTextInbox.onDidDeposit((id) => {
      if (id === session.id) pull()
    })
    return () => sub.dispose()
  }, [session.id])

  // On mount, restore the saved caret position into the textarea DOM so the
  // cursor lands at the right spot when the user refocuses after switching
  // editor tabs.
  useEffect(() => {
    const savedCaret = AcpPromptDraftCache.load(session.id)?.caret
    if (savedCaret != null && savedCaret > 0) {
      editorHandleRef.current?.setSelectionRange(savedCaret, savedCaret)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // mount only — session.id is stable for this component instance

  // Persist the unsent draft (text + range-tracked refs + attached contexts +
  // attached images) per session so switching tabs / sessions and coming back
  // restores it (see AcpPromptDraftCache). Kept alive while any is non-empty so a
  // draft with only attachments (no text yet) survives a tab switch. Refs are
  // read live from the tracker (they change on every edit, which also bumps
  // `text`/`caret`, so this effect re-runs in step).
  useEffect(() => {
    const refs = editorHandleRef.current?.listRefs() ?? []
    if (text || contexts.length > 0 || images.length > 0 || refs.length > 0) {
      AcpPromptDraftCache.save(session.id, { text, refs, contexts, images, caret })
    } else {
      AcpPromptDraftCache.clear(session.id)
    }
  }, [text, contexts, images, caret, session.id])

  const slashQuery = useMemo(() => extractSlashQuery(text, caret), [text, caret])
  const slashMatches = useMemo<readonly AvailableCommand[]>(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
  )
  const imageLimits = useMemo<ImageLimits>(
    () => ({
      maxBytes: (config.get<number>('acp.prompt.image.maxSizeMB') ?? 5) * 1024 * 1024,
      maxCount: config.get<number>('acp.prompt.image.maxCount') ?? 5,
    }),
    [config],
  )

  // Ingest images from paste / drop. Gates on the agent capability,
  // validates each file, then reads it to base64 and appends. Warns once per
  // batch on the first rejection so a bad paste isn't silent.
  const acceptImageFiles = useCallback(
    async (fileList: readonly File[]): Promise<void> => {
      if (fileList.length === 0) return
      if (!imageSupported) {
        notification.notify({
          severity: Severity.Info,
          message: localize(
            'acp.image.unsupported',
            'The current agent does not support image input.',
          ),
        })
        return
      }
      let rejection: ImageRejectReason | null = null
      const accepted: PromptImage[] = []
      // Snapshot the count up front and grow it as we accept, so a single batch
      // that exceeds maxCount is capped correctly.
      let count = images.length
      for (const file of fileList) {
        const reason = validateImage(
          { mimeType: file.type, byteSize: file.size },
          count,
          imageLimits,
        )
        if (reason !== null) {
          rejection ??= reason
          continue
        }
        try {
          accepted.push(await blobToPromptImage(file, generateUuid(), file.name || undefined))
          count++
        } catch {
          rejection ??= 'unsupported-type'
        }
      }
      if (accepted.length > 0) {
        setImages((prev) => [...prev, ...accepted])
        editorHandleRef.current?.focus()
      }
      if (rejection !== null) {
        notification.notify({
          severity: Severity.Warning,
          message: imageRejectMessage(rejection, imageLimits),
        })
      }
    },
    [imageSupported, images.length, imageLimits, notification],
  )

  // Attach images dragged from inside the app (Explorer): an internal drag
  // carries only a URI, so the bytes are read via IFileService. Mirrors
  // acceptImageFiles' gating + validation + one-shot rejection warning.
  const acceptImageUris = useCallback(
    async (uris: readonly URI[]): Promise<void> => {
      if (uris.length === 0) return
      if (!imageSupported) {
        notification.notify({
          severity: Severity.Info,
          message: localize(
            'acp.image.unsupported',
            'The current agent does not support image input.',
          ),
        })
        return
      }
      let rejection: ImageRejectReason | null = null
      const accepted: PromptImage[] = []
      let count = images.length
      for (const uri of uris) {
        const fileName = uri.path.slice(uri.path.lastIndexOf('/') + 1)
        try {
          const bytes = await fileService.readFile(uri)
          const image = bytesToPromptImage(bytes, generateUuid(), fileName)
          const reason = validateImage(
            { mimeType: image.mimeType, byteSize: image.byteSize },
            count,
            imageLimits,
          )
          if (reason !== null) {
            rejection ??= reason
            continue
          }
          accepted.push(image)
          count++
        } catch {
          rejection ??= 'unsupported-type'
        }
      }
      if (accepted.length > 0) {
        setImages((prev) => [...prev, ...accepted])
        editorHandleRef.current?.focus()
      }
      if (rejection !== null) {
        notification.notify({
          severity: Severity.Warning,
          message: imageRejectMessage(rejection, imageLimits),
        })
      }
    },
    [imageSupported, images.length, imageLimits, notification, fileService],
  )

  // Slash popover takes precedence: a buffer that starts with `/` is a
  // slash command, even if it also contains `@`. The mention parser is
  // caret-aware so it only fires when the user is actively typing `@…`.
  const slashOpen = slashQuery !== null && !slashDismissed && commands.length > 0

  // `#` context popover: same slash-precedence rule, checked ahead of `@`
  // mentions (a `#`/`@` token in the same buffer can't both be active, but
  // the guard keeps the priority chain slash > hash > mention explicit).
  const hashQuery: ActiveHashQuery | null = useMemo(
    () => (slashOpen ? null : extractHashQuery(text, caret)),
    [text, caret, slashOpen],
  )
  const hashOpen = hashQuery !== null && !hashDismissed && workspaceRoot !== undefined

  const mentionQuery: ActiveMentionQuery | null = useMemo(
    () => (slashOpen || hashOpen ? null : extractMentionQuery(text, caret)),
    [text, caret, slashOpen, hashOpen],
  )

  // Lazily kick off the workspace file scan the first time `@` is typed.
  useEffect(() => {
    if (mentionQuery === null || files.length > 0 || filesLoading) return
    if (!workspaceRoot) return
    setFilesLoading(true)
    loadWorkspaceFiles(workspaceRoot, fileSearch, {
      dirNames: exclude.getDirNameIgnores(),
      excludeGlobs: exclude.getSearchExcludeGlobs(),
    })
      .then((entries) => setFiles(entries))
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false))
  }, [mentionQuery, files.length, filesLoading, workspaceRoot, fileSearch, exclude])

  const mentionMatches = useMemo<readonly MentionFileEntry[]>(
    () => (mentionQuery === null ? [] : filterMentionFiles(files, mentionQuery.query)),
    [files, mentionQuery],
  )
  // Only open when there's actually a workspace to search — without one we
  // have nothing to suggest, so the popover (including its "Scanning files…"
  // and "No matching files" states) would be pure noise.
  const mentionOpen = mentionQuery !== null && !mentionDismissed && workspaceRoot !== undefined

  // Fetch the three cheap `#` sources (Git changes / open editors / docs)
  // immediately; the symbol search is comparatively expensive (may hit
  // tsserver) so it gets its own 150ms debounce. hashSeqRef discards a slow
  // response that's since been superseded by a newer query.
  useEffect(() => {
    if (hashQuery === null) return
    const seq = ++hashSeqRef.current
    const providers = ensureContextProviders()
    const query = hashQuery.query
    setHashLoading(true)
    void Promise.all([
      providers.scmChange.query(query),
      providers.openEditor.query(query),
      providers.docs.query(query),
      providers.commit.query(query),
    ]).then(([scmChange, openEditor, docs, commit]) => {
      if (seq !== hashSeqRef.current) return
      setHashSuggestions((prev) => ({ ...prev, scmChange, openEditor, docs, commit }))
      setHashLoading(false)
    })
    const timer = setTimeout(() => {
      void providers.symbol.query(query).then((symbol) => {
        if (seq !== hashSeqRef.current) return
        setHashSuggestions((prev) => ({ ...prev, symbol }))
      })
    }, 150)
    return () => clearTimeout(timer)
  }, [hashQuery, ensureContextProviders])

  // Selections are computed live (not queried) — same source used by "Add
  // Selection to Agent Chat" — and filtered client-side against the query.
  const hashSelectionEntries = useMemo<readonly SelectionContext[]>(() => {
    if (hashQuery === null) return []
    const all = collectActiveSelectionContexts(editorService, workspace)
    const q = hashQuery.query.trim().toLowerCase()
    if (!q) return all
    return all.filter((ctx) => formatSelectionLabel(ctx).toLowerCase().includes(q))
  }, [hashQuery, editorService, workspace])

  // One flat suggestion list (no group headers). Each context source is a group;
  // groups are ordered by how many items they contribute, fewest first — so a
  // narrow, high-signal source (e.g. the single "docs" entry) surfaces at the
  // top and a large source (e.g. workspace symbols) sinks to the bottom. Ties
  // keep the source-priority order below (stable sort). Selection and open-editor
  // entries share one group — both answer "what am I looking at right now".
  const hashEntries = useMemo<readonly ContextPopoverEntry[]>(() => {
    const groups: readonly ContextPopoverEntry[][] = [
      hashSuggestions.symbol.map((item) => ({ kind: 'suggestion', item }) as const),
      hashSuggestions.scmChange.map((item) => ({ kind: 'suggestion', item }) as const),
      [
        ...hashSelectionEntries.map((selection) => ({ kind: 'selection', selection }) as const),
        ...hashSuggestions.openEditor.map((item) => ({ kind: 'suggestion', item }) as const),
      ],
      hashSuggestions.docs.map((item) => ({ kind: 'suggestion', item }) as const),
      hashSuggestions.commit.map((item) => ({ kind: 'suggestion', item }) as const),
    ]
    return groups
      .filter((g) => g.length > 0)
      .sort((a, b) => a.length - b.length)
      .flat()
  }, [hashSuggestions, hashSelectionEntries])

  // Report popover open/closed up to the widget service, which flips
  // `acpPromptPopupVisible` for the focused widget. The suggestion commands
  // (Select Next/Prev, Accept, Hide) gate their keybindings on that contextKey.
  const popoverOpen = slashOpen || hashOpen || mentionOpen || historyOpen
  useEffect(() => {
    onPopoverOpenChange?.(popoverOpen)
  }, [onPopoverOpenChange, popoverOpen])

  const acceptSlash = (cmd: AvailableCommand): void => {
    // ACP schema 规定 name 不带 `/`（例如 `create_plan`），但部分实现会带上 —
    // 两种形态都要还原成 `/<name>`，否则提交给 agent 时丢掉 `/`，被当作普通文本。
    const name = cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`
    // 只替换开头的命令名 token，保留其后已写的正文（用户可能先写内容再补 `/cmd`）。
    let end = 1
    while (end < text.length && !/\s/.test(text[end]!)) end++
    const after = text.slice(end)
    const needsSpace = after.length === 0 || !/\s/.test(after[0]!)
    const insert = `${name}${needsSpace ? ' ' : ''}`
    editorHandleRef.current?.setText(insert + after, insert.length)
    setSlashDismissed(true)
    setSlashIndex(0)
    requestAnimationFrame(() => editorHandleRef.current?.focus())
  }

  const acceptMention = (entry: MentionFileEntry, q: ActiveMentionQuery): void => {
    editorHandleRef.current?.insertRef(mentionEntryToRef(entry, 'file'), q.startIndex, q.endIndex)
    setMentionDismissed(true)
    setMentionIndex(0)
    requestAnimationFrame(() => editorHandleRef.current?.focus())
  }

  // `selection` entries route to the existing chip mechanism (setContexts) —
  // the `#<query>` token is simply removed from the text, no inline pill is
  // recorded for it. `suggestion` entries insert an inline reference pill
  // tracked by range, mirroring acceptMention's `@` flow.
  const acceptContextRef = (entry: ContextPopoverEntry, q: ActiveHashQuery): void => {
    if (entry.kind === 'selection') {
      const before = text.slice(0, q.startIndex)
      const after = text.slice(q.endIndex)
      const needsTrailingSpace = after.length === 0 || !/\s/.test(after[0]!)
      const insert = needsTrailingSpace ? ' ' : ''
      const nextText = before + insert + after
      const nextCaret = before.length + insert.length
      editorHandleRef.current?.setText(nextText, nextCaret)
      setContexts((prev) => mergeContexts(prev, [entry.selection]))
      setHashDismissed(true)
      setHashIndex(0)
      requestAnimationFrame(() => editorHandleRef.current?.focus())
      return
    }
    if (entry.item.kind === 'commit') {
      const before = text.slice(0, q.startIndex)
      const after = text.slice(q.endIndex)
      const caret = before.length
      editorHandleRef.current?.setText(before + after, caret)
      setHashDismissed(true)
      setHashIndex(0)
      const picker = instantiation.createInstance(CommitRefPicker)
      void picker.pick().then((ref) => {
        if (ref) editorHandleRef.current?.insertRef(ref, caret, caret)
        requestAnimationFrame(() => editorHandleRef.current?.focus())
      })
      return
    }
    editorHandleRef.current?.insertRef(suggestionItemToRef(entry.item), q.startIndex, q.endIndex)
    setHashDismissed(true)
    setHashIndex(0)
    requestAnimationFrame(() => editorHandleRef.current?.focus())
  }

  // `@@` opens a file picker, `@#` a folder picker. Strip the two-char trigger
  // out of `buffer` (the just-typed textarea value, not the committed `text`
  // state), run the SimpleFileDialog, and on pick splice an `@<name>` mention in
  // at the trigger position — reusing the same recorded-mention pipeline as the
  // popover so it serializes to a resource_link on send.
  const openFilePicker = useCallback(
    async (buffer: string, kind: FilePickerTriggerKind, start: number): Promise<void> => {
      // Remove the trigger chars immediately so the textarea doesn't keep `@@`/`@#`
      // while the dialog is open, and remember where to splice the pick.
      const before = buffer.slice(0, start)
      const after = buffer.slice(start + 2)
      const withoutTrigger = before + after
      editorHandleRef.current?.setText(withoutTrigger, start)

      const picked = await fileDialog.showOpenDialog(
        kind === 'file'
          ? {
              title: localize('acp.mention.pickFile.title', 'Select File to Mention'),
              canSelectFiles: true,
              canSelectFolders: false,
              openLabel: localize('acp.mention.pickFile.open', 'Mention'),
              ...(workspaceRoot ? { defaultUri: workspaceRoot } : {}),
            }
          : {
              title: localize('acp.mention.pickFolder.title', 'Select Folder to Mention'),
              canSelectFiles: false,
              canSelectFolders: true,
              openLabel: localize('acp.mention.pickFolder.open', 'Mention'),
              ...(workspaceRoot ? { defaultUri: workspaceRoot } : {}),
            },
      )
      if (!picked) {
        // Cancelled: leave the trigger-stripped buffer, restore focus/caret.
        requestAnimationFrame(() => {
          const el = editorHandleRef.current
          if (el) {
            el.focus()
            el.setSelectionRange(start, start)
          }
        })
        return
      }

      const mention = toMentionName(picked, workspaceRoot)
      // Space the pill off the preceding text so `@<name>` keeps its boundary.
      const needsLeadingSpace = before.length > 0 && !/\s/.test(before[before.length - 1]!)
      const lead = needsLeadingSpace ? ' ' : ''
      const insertStart = before.length + lead.length
      // Rebuild the buffer with the (optional) leading space, then drop the pill
      // in at the trigger position via the range-tracked insert.
      editorHandleRef.current?.setText(before + lead + after, insertStart)
      editorHandleRef.current?.insertRef(
        mentionEntryToRef({ uri: mention.uri, relPath: mention.name }, kind),
        insertStart,
        insertStart,
      )
      setMentionDismissed(true)
      requestAnimationFrame(() => editorHandleRef.current?.focus())
    },
    [fileDialog, workspaceRoot],
  )

  const acceptHistory = useCallback((): void => {
    setHistoryOpen(false)
    requestAnimationFrame(() => {
      const el = editorHandleRef.current
      if (el) el.setSelectionRange(el.getText().length, el.getText().length)
    })
  }, [])

  const restoreHistoryDraft = useCallback((): void => {
    const draft = historyDraftRef.current
    setHistoryOpen(false)
    editorHandleRef.current?.setText(draft, draft.length)
  }, [])

  // Push the selected history entry into the editor as the user navigates.
  useEffect(() => {
    if (!historyOpen) return
    const entry = historyEntries[historyIndex] ?? ''
    editorHandleRef.current?.setText(entry, entry.length)
  }, [historyOpen, historyIndex, historyEntries])

  popoverStateRef.current = {
    slashOpen,
    mentionOpen,
    hashOpen,
    historyOpen,
    slashMatches,
    mentionMatches,
    hashMatches: hashEntries,
    slashIndex,
    mentionIndex,
    hashIndex,
    historyIndex,
    historyEntries,
    mentionQuery,
    hashQuery,
    acceptSlash,
    acceptMention,
    acceptContextRef,
    acceptHistory,
    restoreHistoryDraft,
  }

  const submit = async (e?: FormEvent | KeyboardEvent): Promise<void> => {
    e?.preventDefault()
    // Allow an image-only prompt (no text) as long as something is attached.
    if (!text.trim() && images.length === 0) return

    const minLen = config.get<number>('acp.prompt.confirmShortFirstMessageLength') ?? 0
    if (minLen > 0 && !hasUserMessages && text.trim().length < minLen && images.length === 0) {
      const { confirmed } = await dialogService.confirm({
        message: localize('acp.prompt.confirmShort.message', 'Send this short message?'),
        detail: localize(
          'acp.prompt.confirmShort.detail',
          'Your first message is quite short. Are you sure you want to send it?',
        ),
        primaryButton: localize('acp.prompt.confirmShort.send', 'Send'),
        cancelButton: localize('acp.prompt.confirmShort.cancel', 'Keep Editing'),
        type: 'info',
      })
      if (!confirmed) return
    }

    const value = text
    const refs = editorHandleRef.current?.listRefs() ?? []
    const attached = contexts
    const attachedImages = images
    editorHandleRef.current?.clearRefs()
    editorHandleRef.current?.setText('', 0)
    setText('')
    AcpPromptDraftCache.clear(session.id)
    setContexts([])
    setImages([])
    setHistoryOpen(false)
    setSlashDismissed(false)
    setMentionDismissed(false)
    setHashDismissed(false)
    setSlashIndex(0)
    setMentionIndex(0)
    setHashIndex(0)
    historyService.push(value)
    void session.sendPrompt(value, refs, attached, attachedImages)
  }

  const revealContext = (ctx: SelectionContext): void => {
    let resource: URI
    try {
      resource = URI.parse(ctx.uri)
    } catch {
      return
    }
    editorService.openEditor(instantiation.createInstance(FileEditorInput, resource), {
      pinned: false,
    })
    // Reveal against the active editor input: openEditor dedupes by resource, so
    // FileEditorRegistry may only know the pre-existing instance (see search).
    const reveal = (): boolean => {
      const active = editorService.activeEditor.get()
      if (!(active instanceof FileEditorInput)) return false
      const editor = FileEditorRegistry.get(active)
      if (!editor) return false
      editor.setSelection({
        startLineNumber: ctx.startLine,
        startColumn: 1,
        endLineNumber: ctx.endLine,
        endColumn: 1,
      })
      editor.revealLineInCenter(ctx.startLine)
      return true
    }
    if (reveal()) return
    setTimeout(reveal, 50)
  }

  // Editor content/caret changed. For programmatic writes (history nav, accept-
  // pick, draft restore) we only mirror text/caret into state; the "user typing"
  // side effects — history close, `@@`/`@#` picker, popover dismissal resets —
  // must run only for real keystrokes, matching the old controlled textarea.
  //
  // `kind` separates a genuine text edit from a bare cursor move. Real Monaco
  // fires a deferred cursor event after a programmatic setText settles, arriving
  // as source:'user' (it lands outside the runProgrammatic window); treating that
  // as typing would close a just-opened history popover (see onEditorArrowUp).
  // So the content-dependent side effects run only on kind==='content'.
  const onEditorChange = (
    v: string,
    c: number,
    source: PromptChangeSource,
    kind: PromptChangeKind,
  ): void => {
    if (source === 'program') {
      setText(v)
      setCaret(c)
      return
    }
    if (kind === 'cursor') {
      // Bare caret move (no text edit): only mirror the caret so popover
      // gating that keys off `caret` stays accurate; never close history or
      // re-trigger pickers/dismissals.
      setCaret(c)
      return
    }
    if (historyOpen) setHistoryOpen(false)
    const trigger = detectFilePickerTrigger(v, c)
    if (trigger) {
      void openFilePicker(v, trigger.kind, trigger.start)
      return
    }
    setText(v)
    setCaret(c)
    if (extractSlashQuery(v, c) === null) setSlashDismissed(false)
    if (extractHashQuery(v, c) === null) setHashDismissed(false)
    if (extractMentionQuery(v, c) === null) setMentionDismissed(false)
    setSlashIndex(0)
    setHashIndex(0)
    setMentionIndex(0)
  }

  // Enter with no open popover submits (popover Enter is claimed by the global
  // command gated on `acpPromptPopupVisible`, which fires before the editor's
  // command). Returns true when consumed so the editor doesn't insert a newline.
  const onEditorEnter = (): boolean => {
    if (popoverOpen) return false
    void submit()
    return true
  }

  // The editor mounted: rebuild any restored draft's reference pills over the
  // already-seeded display text (initialText carried the raw text; the pills need
  // the tracker, which only exists once Monaco is up).
  const onEditorReady = (): void => {
    const refs = initialDraftRef.current.refs
    if (refs.length > 0) editorHandleRef.current?.restoreRefs(refs)
  }

  // ArrowUp on the first line opens history when nothing else is open. Returns
  // true when consumed so Monaco doesn't also move the cursor.
  const onEditorArrowUp = (): boolean => {
    if (popoverOpen || historyEntries.length === 0) return false
    historyDraftRef.current = text
    setHistoryIndex(0)
    setHistoryOpen(true)
    return true
  }

  const onPromptDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!dragContainsResources(e.dataTransfer)) return
    e.preventDefault()
    // NB: do NOT stopPropagation here. When hosted inside an editor group
    // (full-screen session) the body's own dragover handler must still run so it
    // can detect the pointer is over this input (isWithinPromptDropHost) and
    // clear its "open here" overlay — otherwise both glow at once. The drop
    // handler below DOES stopPropagation so the body never re-opens the file.
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const onPromptDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    // Only clear when the pointer actually left the host. The host nests a
    // Monaco editor, so moving from the host padding onto the editor fires a
    // `dragleave` whose relatedTarget is still inside the host — clearing there
    // would make the outline flicker (mirrors EditorGroupView.handleBodyDragLeave).
    const host = dropHostRef.current
    const next = e.relatedTarget as Node | null
    if (host && next && host.contains(next)) return
    if (dropActive) setDropActive(false)
  }

  const onPromptDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    setDropActive(false)
    if (!dragContainsResources(e.dataTransfer)) return
    // A resource drop is ours to handle: preventDefault + stopPropagation up
    // front so it can never bubble to the editor group body (which would open
    // the file) or trigger the browser's navigate-to-file default — even when
    // the drop lands on a part of the input we don't end up consuming.
    e.preventDefault()
    e.stopPropagation()

    // OS-external image files carry real File objects; route them by MIME.
    const imageFiles = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (imageFiles.length > 0) void acceptImageFiles(imageFiles)

    // Split remaining resources: image URIs (internal drag from Explorer, or
    // OS files whose File object we already consumed above) become attachments;
    // everything else becomes an @-mention.
    const droppedFileCount = e.dataTransfer.files?.length ?? 0
    const resources = readDroppedResources(e)
    const imageUris: URI[] = []
    const mentionUris: URI[] = []
    for (const uri of resources) {
      if (mimeTypeForFileName(uri.path) !== '') imageUris.push(uri)
      else mentionUris.push(uri)
    }
    // Only read image URIs when there were no File objects for them (internal
    // drag). When the OS provided Files we already handled them via imageFiles;
    // reading again would double-attach.
    if (droppedFileCount === 0 && imageUris.length > 0) void acceptImageUris(imageUris)

    if (mentionUris.length === 0) return
    const picks = mentionUris.map((uri) => toMentionName(uri, workspaceRoot))
    const el = editorHandleRef.current
    if (!el) return
    // Insert each dropped file as a range-tracked pill at the caret; insertRef
    // advances the caret past the pill (+ trailing space) so the next one lands
    // right after it.
    for (const p of picks) {
      const at = el.getCaret()
      el.insertRef(mentionEntryToRef({ uri: p.uri, relPath: p.name }, 'file'), at, at)
    }
    setMentionDismissed(true)
    requestAnimationFrame(() => el.focus())
  }

  // Safety net for the drop-highlight: a drag can end without ever firing a
  // `drop`/`dragleave` on our host — the user presses Esc, or releases over a
  // different element (the drop lands elsewhere). Both surface as a window-level
  // `dragend`, and any completed drop anywhere fires a window `drop`. Clear the
  // outline on either so it can never stay stuck (VSCode's chat input clears on
  // every drop/leave for the same reason).
  useEffect(() => {
    if (!dropActive) return
    const clear = (): void => setDropActive(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dropActive])

  // Attach an image lifted off the OS clipboard by the main process (base64
  // PNG). Mirrors acceptImageFiles' gating + validation + one-shot rejection.
  const acceptClipboardImage = useCallback(
    (image: { dataBase64: string; mimeType: string; byteSize: number }): void => {
      if (!imageSupported) {
        notification.notify({
          severity: Severity.Info,
          message: localize(
            'acp.image.unsupported',
            'The current agent does not support image input.',
          ),
        })
        return
      }
      const reason = validateImage(
        { mimeType: image.mimeType, byteSize: image.byteSize },
        images.length,
        imageLimits,
      )
      if (reason !== null) {
        notification.notify({
          severity: Severity.Warning,
          message: imageRejectMessage(reason, imageLimits),
        })
        return
      }
      setImages((prev) => [
        ...prev,
        {
          id: generateUuid(),
          mimeType: image.mimeType,
          dataBase64: image.dataBase64,
          byteSize: image.byteSize,
        },
      ])
      editorHandleRef.current?.focus()
    },
    [imageSupported, images.length, imageLimits, notification],
  )

  // EditContext fallback: read the clipboard image via the main-process
  // `clipboard` module (the reliable source — see onPromptPaste). Silent when
  // the clipboard holds no image so a plain-text paste isn't disturbed.
  const readClipboardImageFromHost = useCallback(async (): Promise<void> => {
    try {
      const image = await hostService.readClipboardImage()
      if (image) acceptClipboardImage(image)
    } catch (err) {
      console.debug('[acp-prompt] host clipboard image read failed', err)
    }
  }, [hostService, acceptClipboardImage])

  // Ctrl+V of a screenshot / copied image: attach it. Non-image pastes fall
  // through to the editor.
  //
  // Monaco's `editContext: true` binds a Chromium `EditContext` to the inner
  // `native-edit-context` div. That element (and its DOM ancestors *inside* the
  // Monaco tree) never dispatch `paste` to ordinary `addEventListener` handlers —
  // EditContext owns the input pipeline — so a listener on the editor's own DOM
  // node never fires. The paste event does still propagate (capture phase) down
  // to the surrounding React host div, which is outside Monaco's DOM, so we
  // listen there (see the effect that binds this to `dropHostRef`). Even when it
  // fires, the synchronous `ClipboardEvent` carries no image bytes in this
  // context and `navigator.clipboard.read()` is gated behind an Electron
  // permission the app doesn't grant, so we read the image from the main process.
  const onPromptPaste = useCallback(
    (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      const files: File[] = []
      if (items) {
        for (const item of Array.from(items)) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        void acceptImageFiles(files)
        return
      }
      // Nothing in the sync event. If the agent takes images, ask the main
      // process whether the OS clipboard holds one (EditContext hid it here).
      // Don't preventDefault — a plain-text paste must still reach the editor.
      if (imageSupported) void readClipboardImageFromHost()
    },
    [imageSupported, acceptImageFiles, readClipboardImageFromHost],
  )

  // Bind the paste handler on the host div (outside Monaco's DOM) in the capture
  // phase — the only place a `paste` reliably surfaces with editContext:true.
  useEffect(() => {
    const host = dropHostRef.current
    if (!host) return
    const handler = (e: ClipboardEvent): void => onPromptPaste(e)
    host.addEventListener('paste', handler, true)
    return () => host.removeEventListener('paste', handler, true)
  }, [onPromptPaste])

  return (
    <form className={styles['promptForm']} onSubmit={submit}>
      <SelectionContextChips
        contexts={contexts}
        onRemove={(i) => setContexts((prev) => prev.filter((_, idx) => idx !== i))}
        onReveal={revealContext}
      />
      <PromptImageChips
        images={images}
        onRemove={(id) => setImages((prev) => prev.filter((img) => img.id !== id))}
      />
      <div className={styles['promptComposer']}>
        {historyOpen && historyEntries.length > 0 ? (
          <PromptHistoryPopover
            entries={historyEntries}
            activeIndex={Math.min(historyIndex, Math.max(historyEntries.length - 1, 0))}
            onSelect={(entry) => {
              editorHandleRef.current?.setText(entry, entry.length)
              acceptHistory()
            }}
            onHover={setHistoryIndex}
          />
        ) : slashOpen ? (
          <SlashCommandPopover
            commands={slashMatches}
            activeIndex={Math.min(slashIndex, Math.max(slashMatches.length - 1, 0))}
            onSelect={acceptSlash}
            onHover={setSlashIndex}
          />
        ) : hashOpen && hashQuery !== null ? (
          <ContextPopover
            entries={hashEntries}
            activeIndex={Math.min(hashIndex, Math.max(hashEntries.length - 1, 0))}
            loading={hashLoading}
            onSelect={(entry) => acceptContextRef(entry, hashQuery)}
            onHover={setHashIndex}
          />
        ) : mentionOpen && mentionQuery !== null ? (
          <MentionPopover
            entries={mentionMatches}
            activeIndex={Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0))}
            loading={filesLoading}
            onSelect={(entry) => acceptMention(entry, mentionQuery)}
            onHover={setMentionIndex}
          />
        ) : null}
        <div
          ref={dropHostRef}
          className={[styles['promptEditorHost'], dropActive && styles['dropActive']]
            .filter(Boolean)
            .join(' ')}
          data-testid="acp-prompt-drop-host"
          onDragOver={onPromptDragOver}
          onDragLeave={onPromptDragLeave}
          onDrop={onPromptDrop}
        >
          <PromptMonacoEditor
            handleRef={editorHandleRef}
            configService={config}
            contextKeyService={contextKeyService}
            placeholder={localize('acp.prompt.placeholder', 'Ask the agent…')}
            autoFocus={autoFocus}
            initialText={initialDraftRef.current.text}
            initialCaret={initialDraftRef.current.caret}
            onChange={onEditorChange}
            onEnter={onEditorEnter}
            onArrowUp={onEditorArrowUp}
            onEditorReady={onEditorReady}
          />
        </div>
      </div>
      <div className={styles['promptActions']}>
        <ConfigOptionsBar session={session} />
        {totalRunningMs > 0 || running ? (
          <span
            className={styles['sessionTimerInline']}
            title={localize('acp.session.runningTime', 'Session running time')}
          >
            {formatRunningTime(totalRunningMs)}
          </span>
        ) : null}
        <SessionCostIndicator session={session} />
        <UsageIndicator />
        <CollapseToggleButton mode={collapseMode} onCycle={() => session.cycleCollapseMode()} />
        {running ? <StopButton onCancel={() => void session.cancelTurn()} /> : null}
        <SendButton
          session={session}
          running={running}
          disabled={!text.trim() && images.length === 0}
          onSend={() => {
            void submit()
          }}
        />
      </div>
    </form>
  )
}

/**
 * If the buffer represents an in-progress slash command (starts with `/` and
 * the caret still sits inside the leading command-name token), return the
 * substring after the slash for filtering. Otherwise null to signal "not a
 * slash command", which collapses the popover.
 *
 * Caret-aware (mirrors {@link extractMentionQuery}): the command name is the
 * run from `/` up to the first whitespace. As long as the caret is within that
 * token the popover stays open — even when the user has already typed body
 * text after a space — so one can prepend `/<cmd>` to an existing prompt.
 * Once the caret moves past the whitespace the user is editing the body, and
 * we collapse.
 */
export function extractSlashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  let end = 1
  while (end < text.length && !/\s/.test(text[end]!)) end++
  if (caret > end) return null
  return text.slice(1, end)
}

function imageRejectMessage(reason: ImageRejectReason, limits: ImageLimits): string {
  switch (reason) {
    case 'unsupported-type':
      return localize(
        'acp.image.reject.type',
        'Unsupported image type. Use PNG, JPEG, WebP, or GIF.',
      )
    case 'too-large':
      return localize('acp.image.reject.size', 'Image is too large (max {mb} MB).', {
        mb: Math.round(limits.maxBytes / (1024 * 1024)),
      })
    case 'too-many':
      return localize('acp.image.reject.count', 'Too many images attached (max {n}).', {
        n: limits.maxCount,
      })
  }
}

/**
 * Append incoming selection contexts, dropping duplicates (same file + exact
 * line range) so re-triggering on the same selection doesn't stack chips.
 */
function mergeContexts(
  prev: readonly SelectionContext[],
  incoming: readonly SelectionContext[],
): readonly SelectionContext[] {
  const key = (c: SelectionContext): string => `${c.uri}:${c.startLine}-${c.endLine}`
  const seen = new Set(prev.map(key))
  const out = [...prev]
  for (const c of incoming) {
    const k = key(c)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

const COLLAPSE_ICON: Record<CollapseMode, LucideIcon> = {
  default: AlignJustify,
  collapsed: FoldVertical,
  expanded: UnfoldVertical,
}

const COLLAPSE_TOOLTIP: Record<CollapseMode, string> = {
  default: localize('acp.collapse.default', 'Timeline: Smart folding — click to collapse all'),
  collapsed: localize('acp.collapse.collapsed', 'Timeline: All collapsed — click to expand all'),
  expanded: localize('acp.collapse.expanded', 'Timeline: All expanded — click to reset'),
}

function CollapseToggleButton({ mode, onCycle }: { mode: CollapseMode; onCycle: () => void }) {
  const Icon = COLLAPSE_ICON[mode]
  return (
    <button
      type="button"
      className={styles['collapseToggle']}
      onClick={onCycle}
      title={COLLAPSE_TOOLTIP[mode]}
      aria-label={COLLAPSE_TOOLTIP[mode]}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
