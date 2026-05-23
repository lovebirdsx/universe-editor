/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptInput — the textarea plus two inline popovers (slash-command +
 *  @-mention) for the agent chat. Owns local state (text, caret-tracked
 *  popover index/dismissal, recorded mentions); writes go to the session
 *  via `sendPrompt` / `cancelTurn`. Kept out of ChatView so the keyboard
 *  wiring can be exercised in unit tests without standing up the DI graph.
 *
 *  Mentions strategy: when the user picks a file we record the entry's
 *  display name → URI in local state. On submit we hand the text + the
 *  mention list to `sendPrompt`; the service serializes any `@<name>` that
 *  matches a recorded mention into a `resource_link` AcpContentBlock and
 *  leaves the rest as text. If the user edits/deletes the literal `@<name>`
 *  before sending, the link silently disappears — by design.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { IFileService, IWorkspaceService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, PromptMention } from '../../services/acp/acpSessionService.js'
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
import styles from './agents.module.css'

export function PromptInput({ session }: { session: IAcpSession }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [slashIndex, setSlashIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // User-driven dismissal of the popover for the current token. Reset
  // every time the token disappears so the popover comes back when the
  // user starts a fresh command/mention.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentions, setMentions] = useState<readonly PromptMention[]>([])
  const [files, setFiles] = useState<readonly MentionFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const fileService = useService(IFileService)
  const workspace = useService(IWorkspaceService)
  const workspaceRoot = workspace.current?.folder

  const status = useObservable(session.status)
  const commands = useObservable(session.availableCommands)
  const running = status === 'running'

  const slashQuery = useMemo(() => extractSlashQuery(text), [text])
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
    loadWorkspaceFiles(workspaceRoot, fileService)
      .then((entries) => setFiles(entries))
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false))
  }, [mentionQuery, files.length, filesLoading, workspaceRoot, fileService])

  const mentionMatches = useMemo<readonly MentionFileEntry[]>(
    () => (mentionQuery === null ? [] : filterMentionFiles(files, mentionQuery.query)),
    [files, mentionQuery],
  )
  // Only open when there's actually a workspace to search — without one we
  // have nothing to suggest, so the popover (including its "Scanning files…"
  // and "No matching files" states) would be pure noise.
  const mentionOpen = mentionQuery !== null && !mentionDismissed && workspaceRoot !== undefined

  const acceptSlash = (cmd: AvailableCommand): void => {
    setText(`${cmd.name} `)
    setSlashDismissed(true)
    setSlashIndex(0)
    // Caret will be re-synced by the next textarea event.
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

  const submit = (e?: FormEvent | KeyboardEvent): void => {
    e?.preventDefault()
    if (!text.trim() || running) return
    const value = text
    const recorded = mentions
    setText('')
    setMentions([])
    setSlashDismissed(false)
    setMentionDismissed(false)
    setSlashIndex(0)
    setMentionIndex(0)
    void session.sendPrompt(value, recorded)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Mention popover has priority over slash popover for keyboard handling
    // since the caret-aware mention parser only fires when the user is
    // actively in a `@` token.
    if (mentionOpen && mentionMatches.length > 0 && mentionQuery !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const target = mentionMatches[mentionIndex] ?? mentionMatches[0]
        if (target) acceptMention(target, mentionQuery)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const target = slashMatches[slashIndex] ?? slashMatches[0]
        if (target) acceptSlash(target)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const target = slashMatches[slashIndex] ?? slashMatches[0]
        if (target) acceptSlash(target)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
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
          className={styles['promptTextarea']}
          value={text}
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            setCaret(e.target.selectionStart ?? v.length)
            if (extractSlashQuery(v) === null) setSlashDismissed(false)
            // Reset mention dismissal as soon as the `@` token disappears.
            const next = extractMentionQuery(v, e.target.selectionStart ?? v.length)
            if (next === null) setMentionDismissed(false)
            setSlashIndex(0)
            setMentionIndex(0)
          }}
          onKeyUp={syncCaretFromEvent}
          onClick={syncCaretFromEvent}
          onFocus={syncCaretFromEvent}
          placeholder={localize('acp.prompt.placeholder', 'Ask the agent…')}
          rows={3}
          onKeyDown={onKeyDown}
          data-testid="acp-prompt-input"
        />
      </div>
      <div className={styles['promptActions']}>
        {running ? (
          <button
            type="button"
            className={styles['cancelButton']}
            onClick={() => void session.cancelTurn()}
            data-testid="acp-prompt-cancel"
          >
            {localize('acp.prompt.cancel', 'Cancel')}
          </button>
        ) : (
          <button
            type="submit"
            className={styles['sendButton']}
            disabled={!text.trim()}
            data-testid="acp-prompt-send"
          >
            {localize('acp.prompt.send', 'Send')}
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * If the buffer represents an in-progress slash command (starts with `/`,
 * and the cursor still sits inside the command name — i.e. no whitespace
 * yet), return the substring after the slash for filtering. Otherwise null
 * to signal "not a slash command", which collapses the popover.
 */
export function extractSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  if (/\s/.test(rest)) return null
  return rest
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
