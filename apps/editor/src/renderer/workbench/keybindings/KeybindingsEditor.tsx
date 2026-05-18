/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard Shortcuts editor: searchable table of all commands with their
 *  keybindings; supports inline key recording and per-command user overrides.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useReducer, useRef, useState, type JSX } from 'react'
import { CommandsRegistry, KeybindingsRegistry } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { formatKey, formatChord } from '../titlebar/keybindingFormat.js'
import { IUserKeybindingsService } from './UserKeybindingsService.js'
import { MONACO_COMMAND_CATALOG } from '../editor/monaco/monacoCommandCatalog.js'
import styles from './KeybindingsEditor.module.css'

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

function isModifierOnly(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'control' || k === 'shift' || k === 'alt' || k === 'meta'
}

/** Display a normalized key like 'ctrl+shift+b' as individual <kbd> chips. */
function KeyChips({ keyStr }: { keyStr: string }): JSX.Element {
  const parts = keyStr.split('+')
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={styles['kbd']}>
          {p}
        </span>
      ))}
    </>
  )
}

/** Inline key-recording widget. Replaces the keybinding cell while active. */
function KeyRecorder({
  onConfirm,
  onCancel,
}: {
  onConfirm: (key: string) => void
  onCancel: () => void
}): JSX.Element {
  const [pending, setPending] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()

    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        onCancel()
        return
      }
      if (e.key === 'Enter') {
        if (pending) onConfirm(pending)
        else onCancel()
        return
      }
      if (isModifierOnly(e.key)) return

      setPending(buildKeyString(e))
    }

    // Capture phase so we intercept before global handler.
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [pending, onConfirm, onCancel])

  return (
    <div className={styles['recorder']}>
      <input
        ref={inputRef}
        readOnly
        className={styles['recorderInput']}
        value={pending ? formatKey(pending) : ''}
        placeholder="Press a key…"
      />
      {pending ? (
        <>
          <button className={styles['btn']} onClick={() => onConfirm(pending)}>
            OK
          </button>
          <button className={styles['btn']} onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : (
        <span className={styles['recorderHint']}>Esc to cancel</span>
      )}
    </div>
  )
}

interface CommandRow {
  id: string
  label: string
  category?: string | undefined
}

export function KeybindingsEditor(): JSX.Element {
  const userKeybindingsService = useService(IUserKeybindingsService)
  const [query, setQuery] = useState('')
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [recordingCommand, setRecordingCommand] = useState<string | null>(null)

  // Re-render on user keybinding changes.
  useEffect(() => {
    const d = userKeybindingsService.onDidChange(() => bump())
    return () => d.dispose()
  }, [userKeybindingsService])

  // Build the list of all commands that have metadata (i.e., were registered via
  // Action2 with a title/category — these are the user-visible commands).
  const allCommands: CommandRow[] = [...CommandsRegistry.getCommands().values()]
    .filter((cmd) => cmd.metadata !== undefined)
    .map((cmd) => ({
      id: cmd.id,
      label: cmd.metadata?.description ?? cmd.id,
      category: cmd.metadata?.category,
    }))
    .sort((a, b) => {
      const ac = a.category ?? ''
      const bc = b.category ?? ''
      if (ac !== bc) return ac.localeCompare(bc)
      return a.label.localeCompare(b.label)
    })

  const normQuery = query.trim().toLowerCase()

  const filtered = normQuery
    ? allCommands.filter((cmd) => {
        if (cmd.label.toLowerCase().includes(normQuery)) return true
        if (cmd.id.toLowerCase().includes(normQuery)) return true
        const effective = getEffectiveKey(cmd.id, userKeybindingsService)
        if (effective && effective.toLowerCase().includes(normQuery)) return true
        return false
      })
    : allCommands

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <input
          className={styles['search']}
          type="search"
          placeholder={`Search keybindings (${allCommands.length})`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setRecordingCommand(null)
          }}
        />
      </div>

      <div className={styles['body']}>
        {filtered.length === 0 ? (
          <div className={styles['empty']}>No matching keybindings.</div>
        ) : (
          <table className={styles['table']}>
            <thead className={styles['thead']}>
              <tr>
                <th className={styles['th']}>Command</th>
                <th className={styles['th']}>Keybinding</th>
                <th className={styles['th']}>Source</th>
                <th className={styles['th']} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((cmd) => {
                const userEntry = userKeybindingsService.getUserEntry(cmd.id)
                const isUser = userEntry !== undefined
                const effectiveKey = getEffectiveKey(cmd.id, userKeybindingsService)
                const isRecording = recordingCommand === cmd.id

                return (
                  <tr
                    key={cmd.id}
                    className={`${styles['row']} ${isUser ? styles['userRow'] : ''}`}
                  >
                    {/* Command */}
                    <td className={styles['td']}>
                      <div className={styles['commandName']}>
                        {cmd.category ? `${cmd.category}: ${cmd.label}` : cmd.label}
                      </div>
                      <div className={styles['commandId']}>{cmd.id}</div>
                    </td>

                    {/* Keybinding */}
                    <td className={styles['td']}>
                      {isRecording ? (
                        <KeyRecorder
                          onConfirm={(key) => {
                            userKeybindingsService.setKeybinding(cmd.id, key)
                            setRecordingCommand(null)
                          }}
                          onCancel={() => setRecordingCommand(null)}
                        />
                      ) : effectiveKey ? (
                        <span className={styles['keybinding']}>
                          <KeyChips keyStr={effectiveKey} />
                        </span>
                      ) : (
                        <span className={`${styles['keybinding']} ${styles['none']}`}>—</span>
                      )}
                    </td>

                    {/* Source */}
                    <td className={styles['td']}>
                      <span
                        className={`${styles['sourceTag']} ${isUser ? styles['user'] : styles['default']}`}
                      >
                        {isUser ? 'User' : 'Default'}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className={styles['td']}>
                      {!isRecording && (
                        <div className={styles['actions']}>
                          <button
                            className={styles['btn']}
                            title="Edit keybinding"
                            onClick={() => setRecordingCommand(cmd.id)}
                          >
                            Edit
                          </button>
                          {isUser && (
                            <button
                              className={`${styles['btn']} ${styles['danger']}`}
                              title="Reset to default"
                              onClick={() => userKeybindingsService.resetKeybinding(cmd.id)}
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function getEffectiveKey(command: string, svc: IUserKeybindingsService): string | undefined {
  const userEntry = svc.getUserEntry(command)
  if (userEntry !== undefined) {
    return userEntry.key !== null ? formatKey(userEntry.key) : undefined
  }

  // No user override — return default from registry.
  const all = KeybindingsRegistry.getAllKeybindings()
  for (let i = all.length - 1; i >= 0; i--) {
    const kb = all[i]
    if (!kb || kb.command !== command || kb.isNegated) continue
    if (kb.chords) return formatChord(kb.chords)
    if (kb.key !== undefined) return formatKey(kb.key)
  }

  // Fall back to Monaco command catalog for built-in editor commands.
  const monacoEntry = MONACO_COMMAND_CATALOG.find((c) => c.id === command)
  return monacoEntry?.defaultKey ? formatKey(monacoEntry.defaultKey) : undefined
}
