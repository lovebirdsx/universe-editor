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
  IFileDialogService,
  IFileSearchService,
  IFileService,
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
import type {
  IAcpSession,
  PromptMention,
  SelectionContext,
} from '../../services/acp/acpSessionService.js'
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
  applyMentionPick,
  detectFilePickerTrigger,
  extractMentionQuery,
  type ActiveMentionQuery,
  type FilePickerTriggerKind,
} from '../../services/acp/promptMentions.js'
import {
  filterMentionFiles,
  loadWorkspaceFiles,
  type MentionFileEntry,
} from '../../services/acp/mentionFileSearch.js'
import { MentionPopover } from './MentionPopover.js'
import { SelectionContextChips } from './SelectionContextChips.js'
import { PromptImageChips } from './PromptImageChips.js'
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
  historyOpen: boolean
  slashMatches: readonly AvailableCommand[]
  mentionMatches: readonly MentionFileEntry[]
  slashIndex: number
  mentionIndex: number
  historyIndex: number
  historyEntries: readonly string[]
  mentionQuery: ActiveMentionQuery | null
  acceptSlash: (cmd: AvailableCommand) => void
  acceptMention: (entry: MentionFileEntry, q: ActiveMentionQuery) => void
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
  const [dropActive, setDropActive] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(0)
  // User-driven dismissal of the popover for the current token. Reset
  // every time the token disappears so the popover comes back when the
  // user starts a fresh command/mention.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentions, setMentions] = useState<readonly PromptMention[]>(
    () => AcpPromptDraftCache.load(session.id)?.mentions ?? [],
  )
  const [contexts, setContexts] = useState<readonly SelectionContext[]>(
    () => AcpPromptDraftCache.load(session.id)?.contexts ?? [],
  )
  const [images, setImages] = useState<readonly PromptImage[]>(
    () => AcpPromptDraftCache.load(session.id)?.images ?? [],
  )
  const [files, setFiles] = useState<readonly MentionFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Saves the in-progress draft text when the user enters history navigation mode,
  // so Escape / Down-past-end restores it.
  const historyDraftRef = useRef('')
  // Latest popover state + accept callbacks, read by the WidgetHandle methods
  // (bound once) when a suggestion command fires. Refreshed every render.
  const popoverStateRef = useRef<PopoverHandleState | null>(null)

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

  // Expose `focus()` plus the popover navigation methods to the AcpChatWidget
  // handle. The widget service routes the suggestion commands (Select Next/Prev,
  // Accept, Hide — gated on `acpPromptPopupVisible`) and Ctrl+Alt+I here without
  // a global event bus. The methods read `popoverStateRef` so they always act on
  // the live state without re-binding every render.
  useEffect(() => {
    if (!handleRef) return
    const ref = handleRef
    ref.current.focus = () => {
      const el = textareaRef.current
      if (!el) return false
      el.focus()
      return true
    }
    ref.current.popoverSelectNext = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        if (s.historyIndex < s.historyEntries.length - 1) {
          setHistoryIndex((i) => i + 1)
        }
        return
      }
      if (s.mentionOpen && s.mentionMatches.length > 0) {
        setMentionIndex((i) => (i + 1) % s.mentionMatches.length)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        setSlashIndex((i) => (i + 1) % s.slashMatches.length)
      }
    }
    ref.current.popoverSelectPrev = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.historyOpen) {
        if (s.historyIndex > 0) {
          setHistoryIndex((i) => i - 1)
        } else {
          s.restoreHistoryDraft()
        }
        return
      }
      if (s.mentionOpen && s.mentionMatches.length > 0) {
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
      if (s.mentionOpen && s.mentionQuery !== null && s.mentionMatches.length > 0) {
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
      if (s.mentionOpen) setMentionDismissed(true)
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
      textareaRef.current?.focus()
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
    if (autoFocus) textareaRef.current?.focus()
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
      textareaRef.current?.focus()
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
      setText((prev) => {
        const joined = incoming.join('\n')
        const next = prev ? `${prev}\n${joined}` : joined
        setCaret(next.length)
        const el = textareaRef.current
        if (el) {
          requestAnimationFrame(() => {
            el.focus()
            el.setSelectionRange(next.length, next.length)
          })
        }
        return next
      })
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
    if (savedCaret != null && savedCaret > 0 && textareaRef.current) {
      textareaRef.current.setSelectionRange(savedCaret, savedCaret)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // mount only — session.id is stable for this component instance

  // Persist the unsent draft (text + recorded mentions + attached contexts +
  // attached images) per session so switching tabs / sessions and coming back
  // restores it (see AcpPromptDraftCache). Kept alive while any of the four is
  // non-empty so a draft with only attachments (no text yet) survives a tab
  // switch.
  useEffect(() => {
    if (text || contexts.length > 0 || images.length > 0) {
      AcpPromptDraftCache.save(session.id, { text, mentions, contexts, images, caret })
    } else {
      AcpPromptDraftCache.clear(session.id)
    }
  }, [text, mentions, contexts, images, caret, session.id])

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
        textareaRef.current?.focus()
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
        textareaRef.current?.focus()
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

  const mentionQuery: ActiveMentionQuery | null = useMemo(
    () => (slashOpen ? null : extractMentionQuery(text, caret)),
    [text, caret, slashOpen],
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

  // Report popover open/closed up to the widget service, which flips
  // `acpPromptPopupVisible` for the focused widget. The suggestion commands
  // (Select Next/Prev, Accept, Hide) gate their keybindings on that contextKey.
  const popoverOpen = slashOpen || mentionOpen || historyOpen
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
    setText(insert + after)
    setCaret(insert.length)
    setSlashDismissed(true)
    setSlashIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(insert.length, insert.length)
      }
    })
  }

  const acceptMention = (entry: MentionFileEntry, q: ActiveMentionQuery): void => {
    const r = applyMentionPick(text, q, entry.relPath)
    setText(r.text)
    setCaret(r.caret)
    setMentions((prev) => mergeMention(prev, { uri: entry.uri, name: entry.relPath }))
    setMentionDismissed(true)
    setMentionIndex(0)
    // Restore caret on the next tick — React will rerender the textarea
    // before the imperative selection update lands.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(r.caret, r.caret)
      }
    })
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
      setText(withoutTrigger)
      setCaret(start)

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
          const el = textareaRef.current
          if (el) {
            el.focus()
            el.setSelectionRange(start, start)
          }
        })
        return
      }

      const mention = toMentionName(picked, workspaceRoot)
      // Space the mention off the surrounding text so `@<name>` keeps its boundary.
      const needsLeadingSpace = before.length > 0 && !/\s/.test(before[before.length - 1]!)
      const needsTrailingSpace = after.length === 0 || !/\s/.test(after[0]!)
      const insert = `${needsLeadingSpace ? ' ' : ''}@${mention.name}${needsTrailingSpace ? ' ' : ''}`
      const nextText = before + insert + after
      const nextCaret = before.length + insert.length
      setText(nextText)
      setCaret(nextCaret)
      setMentions((prev) => mergeMention(prev, mention))
      setMentionDismissed(true)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(nextCaret, nextCaret)
        }
      })
    },
    [fileDialog, workspaceRoot],
  )

  const acceptHistory = useCallback((): void => {
    setHistoryOpen(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [])

  const restoreHistoryDraft = useCallback((): void => {
    const draft = historyDraftRef.current
    setHistoryOpen(false)
    setText(draft)
    setCaret(draft.length)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) el.setSelectionRange(draft.length, draft.length)
    })
  }, [])

  // Sync textarea text when the user navigates through history entries.
  useEffect(() => {
    if (!historyOpen) return
    const entry = historyEntries[historyIndex] ?? ''
    setText(entry)
    setCaret(entry.length)
  }, [historyOpen, historyIndex, historyEntries])

  popoverStateRef.current = {
    slashOpen,
    mentionOpen,
    historyOpen,
    slashMatches,
    mentionMatches,
    slashIndex,
    mentionIndex,
    historyIndex,
    historyEntries,
    mentionQuery,
    acceptSlash,
    acceptMention,
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
    const recorded = mentions
    const attached = contexts
    const attachedImages = images
    setText('')
    AcpPromptDraftCache.clear(session.id)
    setMentions([])
    setContexts([])
    setImages([])
    setHistoryOpen(false)
    setSlashDismissed(false)
    setMentionDismissed(false)
    setSlashIndex(0)
    setMentionIndex(0)
    historyService.push(value)
    void session.sendPrompt(value, recorded, attached, attachedImages)
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Open history popover when ↑ is pressed on the first line and no other
    // popover is active. Once open, navigation is routed through the global
    // WidgetHandle commands gated on `acpPromptPopupVisible`.
    if (!popoverOpen && e.key === 'ArrowUp') {
      const ta = textareaRef.current
      if (ta && isOnFirstLine(ta) && historyEntries.length > 0) {
        e.preventDefault()
        historyDraftRef.current = text
        setHistoryIndex(0)
        setHistoryOpen(true)
        return
      }
    }
    // Popover navigation / accept / hide is handled by global commands gated on
    // `acpPromptPopupVisible` (see agentActions). When a popover is open the
    // global handler consumes those keys before they reach here. We only own the
    // plain-Enter submit while no popover is open.
    if (popoverOpen) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit(e)
    }
  }

  const syncCaretFromEvent = (
    e:
      | React.ChangeEvent<HTMLTextAreaElement>
      | React.KeyboardEvent<HTMLTextAreaElement>
      | React.MouseEvent<HTMLTextAreaElement>
      | React.FocusEvent<HTMLTextAreaElement>,
  ): void => {
    const t = e.currentTarget
    setCaret(t.selectionStart ?? t.value.length)
  }

  const onPromptDragOver = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    if (!dragContainsResources(e.dataTransfer)) return
    e.preventDefault()
    // Stop the editor group body from also reacting when the chat input is
    // hosted inside an editor group (full-screen session).
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const onPromptDragLeave = (): void => {
    if (dropActive) setDropActive(false)
  }

  const onPromptDrop = (e: React.DragEvent<HTMLTextAreaElement>): void => {
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
    let next = text
    let pos = textareaRef.current?.selectionStart ?? caret
    for (const p of picks) {
      const insert = `@${p.name} `
      next = next.slice(0, pos) + insert + next.slice(pos)
      pos += insert.length
    }
    setText(next)
    setCaret(pos)
    setMentions((prev) => picks.reduce((acc, p) => mergeMention(acc, p), prev))
    setMentionDismissed(true)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  // Ctrl+V of a screenshot / copied image: pull image files out of the
  // clipboard and attach them. Non-image pastes fall through to the textarea.
  const onPromptPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length === 0) return
    e.preventDefault()
    void acceptImageFiles(files)
  }

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
              setText(entry)
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
        ) : mentionOpen && mentionQuery !== null ? (
          <MentionPopover
            entries={mentionMatches}
            activeIndex={Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0))}
            loading={filesLoading}
            onSelect={(entry) => acceptMention(entry, mentionQuery)}
            onHover={setMentionIndex}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          className={[styles['promptTextarea'], dropActive && styles['dropActive']]
            .filter(Boolean)
            .join(' ')}
          value={text}
          onChange={(e) => {
            if (historyOpen) setHistoryOpen(false)
            const v = e.target.value
            const c = e.target.selectionStart ?? v.length
            // `@@` / `@#` just landed → open the file/folder picker instead of
            // continuing as plain text (handles the trigger + rewrites the buffer).
            const trigger = detectFilePickerTrigger(v, c)
            if (trigger) {
              void openFilePicker(v, trigger.kind, trigger.start)
              return
            }
            setText(v)
            setCaret(c)
            if (extractSlashQuery(v, c) === null) setSlashDismissed(false)
            // Reset mention dismissal as soon as the `@` token disappears.
            const next = extractMentionQuery(v, c)
            if (next === null) setMentionDismissed(false)
            setSlashIndex(0)
            setMentionIndex(0)
          }}
          onKeyUp={syncCaretFromEvent}
          onClick={syncCaretFromEvent}
          onFocus={syncCaretFromEvent}
          onDragOver={onPromptDragOver}
          onDragLeave={onPromptDragLeave}
          onDrop={onPromptDrop}
          onPaste={onPromptPaste}
          placeholder={localize('acp.prompt.placeholder', 'Ask the agent…')}
          rows={3}
          spellCheck={false}
          onKeyDown={onKeyDown}
          data-testid="acp-prompt-input"
        />
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

/** Returns true when the textarea cursor sits on the first visual line. */
function isOnFirstLine(ta: HTMLTextAreaElement): boolean {
  const caret = ta.selectionStart ?? 0
  const beforeCaret = ta.value.slice(0, caret)
  if (beforeCaret.includes('\n')) return false
  if (caret === 0) return true

  const doc = ta.ownerDocument
  const win = doc.defaultView
  if (!win || !doc.body || ta.clientWidth <= 0) return true

  const computed = win.getComputedStyle(ta)
  const mirror = doc.createElement('div')
  mirror.setAttribute('aria-hidden', 'true')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  mirror.style.left = '-10000px'
  mirror.style.top = '0'
  mirror.style.width = `${ta.clientWidth}px`
  mirror.style.height = 'auto'
  mirror.style.minHeight = '0'
  mirror.style.maxHeight = 'none'
  mirror.style.overflow = 'visible'
  mirror.style.boxSizing = 'border-box'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'

  const copiedProperties = [
    'direction',
    'font-family',
    'font-size',
    'font-style',
    'font-variant',
    'font-weight',
    'letter-spacing',
    'line-height',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top',
    'tab-size',
    'text-indent',
    'text-rendering',
    'text-transform',
    'word-break',
    'word-spacing',
  ]
  for (const property of copiedProperties) {
    mirror.style.setProperty(property, computed.getPropertyValue(property))
  }

  const firstLineProbe = doc.createElement('span')
  firstLineProbe.setAttribute('data-acp-prompt-line-probe', 'start')
  firstLineProbe.textContent = '\u200b'
  const caretProbe = doc.createElement('span')
  caretProbe.setAttribute('data-acp-prompt-line-probe', 'caret')
  caretProbe.textContent = '\u200b'
  mirror.append(firstLineProbe, doc.createTextNode(beforeCaret), caretProbe)

  try {
    doc.body.appendChild(mirror)
    const firstTop = firstLineProbe.getBoundingClientRect().top
    const caretTop = caretProbe.getBoundingClientRect().top
    return Math.abs(caretTop - firstTop) <= 1
  } finally {
    mirror.remove()
  }
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
 * Merge a new mention into the existing list, deduplicating by name. We key
 * by display name because that's what the wire-format serializer matches
 * against in {@link composePromptBlocks}.
 */
function mergeMention(
  prev: readonly PromptMention[],
  next: PromptMention,
): readonly PromptMention[] {
  const out = prev.filter((m) => m.name !== next.name)
  out.push(next)
  return out
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
