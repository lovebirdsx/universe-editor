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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react'
import { IFileSearchService, IWorkspaceService, localize } from '@universe-editor/platform'
import { dragContainsResources } from '@universe-editor/workbench-ui'
import { readDroppedResources, toMentionName } from '../../services/dnd/resourceDropTransfer.js'
import { AlignJustify, FoldVertical, UnfoldVertical, type LucideIcon } from 'lucide-react'
import type { CollapseMode } from '../../services/acp/acpChatViewStateCache.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, PromptMention } from '../../services/acp/acpSessionService.js'
import type { WidgetHandle } from './ChatBody.js'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  applyMentionPick,
  extractMentionQuery,
  type ActiveMentionQuery,
} from '../../services/acp/promptMentions.js'
import {
  filterMentionFiles,
  loadWorkspaceFiles,
  type MentionFileEntry,
} from '../../services/acp/mentionFileSearch.js'
import { MentionPopover } from './MentionPopover.js'
import { SlashCommandPopover, filterCommands } from './SlashCommandPopover.js'
import { ConfigOptionsBar } from './ConfigOptionsBar.js'
import { SendButton } from './SendButton.js'
import { StopButton } from './StopButton.js'
import { AcpPromptDraftCache } from '../../services/acp/acpPromptDraftCache.js'
import { useSessionTimer, formatRunningTime } from './useSessionTimer.js'
import styles from './agents.module.css'

const MIN_PROMPT_ROWS = 3
const MAX_PROMPT_ROWS = 16

// Snapshot of the live popover state + accept callbacks, kept in a ref so the
// WidgetHandle popover methods (bound once) act on current data when a
// suggestion command fires.
interface PopoverHandleState {
  slashOpen: boolean
  mentionOpen: boolean
  slashMatches: readonly AvailableCommand[]
  mentionMatches: readonly MentionFileEntry[]
  slashIndex: number
  mentionIndex: number
  mentionQuery: ActiveMentionQuery | null
  acceptSlash: (cmd: AvailableCommand) => void
  acceptMention: (entry: MentionFileEntry, q: ActiveMentionQuery) => void
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
  // User-driven dismissal of the popover for the current token. Reset
  // every time the token disappears so the popover comes back when the
  // user starts a fresh command/mention.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentions, setMentions] = useState<readonly PromptMention[]>(
    () => AcpPromptDraftCache.load(session.id)?.mentions ?? [],
  )
  const [files, setFiles] = useState<readonly MentionFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Latest popover state + accept callbacks, read by the WidgetHandle methods
  // (bound once) when a suggestion command fires. Refreshed every render.
  const popoverStateRef = useRef<PopoverHandleState | null>(null)

  useLayoutEffect(() => {
    resizePromptTextarea(textareaRef.current)
  }, [text])

  const fileSearch = useService(IFileSearchService)
  const workspace = useService(IWorkspaceService)
  const exclude = useService(IExcludeService)
  const workspaceRoot = workspace.current?.folder

  const status = useObservable(session.status)
  const commands = useObservable(session.availableCommands)
  const running = status === 'running'
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
      textareaRef.current?.focus()
    }
    ref.current.popoverSelectNext = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.mentionOpen && s.mentionMatches.length > 0) {
        setMentionIndex((i) => (i + 1) % s.mentionMatches.length)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        setSlashIndex((i) => (i + 1) % s.slashMatches.length)
      }
    }
    ref.current.popoverSelectPrev = () => {
      const s = popoverStateRef.current
      if (!s) return
      if (s.mentionOpen && s.mentionMatches.length > 0) {
        setMentionIndex((i) => (i - 1 + s.mentionMatches.length) % s.mentionMatches.length)
      } else if (s.slashOpen && s.slashMatches.length > 0) {
        setSlashIndex((i) => (i - 1 + s.slashMatches.length) % s.slashMatches.length)
      }
    }
    ref.current.popoverAccept = () => {
      const s = popoverStateRef.current
      if (!s) return
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
      if (s.mentionOpen) setMentionDismissed(true)
      else if (s.slashOpen) setSlashDismissed(true)
    }
    return () => {
      ref.current.focus = () => {}
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

  // Initial-mount focus for callers that opt in (full-screen editor).
  // Sidebar leaves this false so opening the ChatPanel doesn't yank focus
  // from whatever the user just clicked.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

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

  // Persist the unsent draft (text + recorded mentions) per session so
  // switching tabs / sessions and coming back restores it (see
  // AcpPromptDraftCache).
  useEffect(() => {
    if (text) AcpPromptDraftCache.save(session.id, { text, mentions, caret })
    else AcpPromptDraftCache.clear(session.id)
  }, [text, mentions, caret, session.id])

  const slashQuery = useMemo(() => extractSlashQuery(text, caret), [text, caret])
  const slashMatches = useMemo<readonly AvailableCommand[]>(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
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
  const popoverOpen = slashOpen || mentionOpen
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

  popoverStateRef.current = {
    slashOpen,
    mentionOpen,
    slashMatches,
    mentionMatches,
    slashIndex,
    mentionIndex,
    mentionQuery,
    acceptSlash,
    acceptMention,
  }

  const submit = (e?: FormEvent | KeyboardEvent): void => {
    e?.preventDefault()
    if (!text.trim()) return
    const value = text
    const recorded = mentions
    setText('')
    AcpPromptDraftCache.clear(session.id)
    setMentions([])
    setSlashDismissed(false)
    setMentionDismissed(false)
    setSlashIndex(0)
    setMentionIndex(0)
    void session.sendPrompt(value, recorded)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Popover navigation / accept / hide is handled by global commands gated on
    // `acpPromptPopupVisible` (see agentActions). When a popover is open the
    // global handler consumes those keys before they reach here. We only own the
    // plain-Enter submit while no popover is open.
    if (popoverOpen) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(e)
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
    const resources = readDroppedResources(e)
    if (resources.length === 0) return
    e.preventDefault()
    // Prevent the drop from bubbling to the editor group body, which would
    // otherwise open the dropped files as editors instead of @-mentioning them.
    e.stopPropagation()
    const picks = resources.map((uri) => toMentionName(uri, workspaceRoot))
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

  return (
    <form className={styles['promptForm']} onSubmit={submit}>
      <div className={styles['promptComposer']}>
        {slashOpen ? (
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
            const v = e.target.value
            const c = e.target.selectionStart ?? v.length
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
          <span className={styles['sessionTimerInline']} title="Session running time">
            {formatRunningTime(totalRunningMs)}
          </span>
        ) : null}
        <CollapseToggleButton mode={collapseMode} onCycle={() => session.cycleCollapseMode()} />
        {running ? <StopButton onCancel={() => void session.cancelTurn()} /> : null}
        <SendButton
          session={session}
          running={running}
          disabled={!text.trim()}
          onSend={() => submit()}
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

function resizePromptTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return
  const style = getComputedStyle(el)
  const lineHeight = cssPixels(style.lineHeight) ?? (cssPixels(style.fontSize) ?? 12) * 1.5
  const verticalInsets =
    (cssPixels(style.paddingTop) ?? 0) +
    (cssPixels(style.paddingBottom) ?? 0) +
    (cssPixels(style.borderTopWidth) ?? 0) +
    (cssPixels(style.borderBottomWidth) ?? 0)
  const minHeight = Math.ceil(lineHeight * MIN_PROMPT_ROWS + verticalInsets)
  const maxHeight = Math.ceil(lineHeight * MAX_PROMPT_ROWS + verticalInsets)

  el.style.height = 'auto'
  const contentHeight = Math.max(el.scrollHeight, minHeight)
  const nextHeight = Math.min(contentHeight, maxHeight)
  el.style.height = `${nextHeight}px`
  el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
}

function cssPixels(value: string): number | undefined {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
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
