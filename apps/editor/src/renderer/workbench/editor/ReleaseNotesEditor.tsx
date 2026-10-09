/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ReleaseNotesEditor — one section per version: a header (version / date / title /
 *  summary) plus the version's markdown body rendered by the shared MarkdownView.
 *
 *  Release notes are the one consumer allowed to link with `doc:` / `command:`, and
 *  this editor is the only place that grants it. "Missing doc" is NOT resolved against
 *  the running install: the note's own version decides the GitHub fallback, so a note
 *  about 0.12.0 can never link at main or at the current release.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useRef } from 'react'
import {
  IEditorInput,
  IEditorService,
  IOpenerService,
  INotificationService,
  Severity,
  localize,
} from '@universe-editor/platform'
import type { IReleaseNote } from '../../../shared/ipc/releaseNotesService.js'
import {
  classifyReleaseNoteHref,
  releaseNoteDocUrl,
  releaseNoteHrefSchemes,
  type ReleaseNoteHrefKind,
} from '../../../shared/releaseNotes/linkPolicy.js'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import { isDocId } from '../../services/editor/docRegistry.js'
import { openDocInGroup } from '../../services/editor/openDoc.js'
import { ReleaseNotesInput } from '../../services/editor/ReleaseNotesInput.js'
import { useService } from '../useService.js'
import { MarkdownView, type MarkdownLinkHandler } from '../markdown/MarkdownView.js'
import { useEditorGroup } from './EditorGroupContext.js'
import styles from './ReleaseNotesEditor.module.css'

const MD_LINK_SCHEMES = releaseNoteHrefSchemes()

function versionAnchor(version: string): string {
  return `version-${version.replace(/[^A-Za-z0-9]+/g, '-')}`
}

function ReleaseNoteSection({ note }: { readonly note: IReleaseNote }) {
  const groups = useEditorGroup()
  const editorService = useService(IEditorService)
  const opener = useService(IOpenerService)
  const notifications = useService(INotificationService)

  const openExternal = useCallback(
    (url: string) => {
      void opener.open(url, { fromUserGesture: true })
    },
    [opener],
  )

  // A doc this install does not bundle: offer the note's own version on GitHub.
  const reportMissingDoc = useCallback(
    (docId: string) => {
      const url = note.version === '' ? undefined : releaseNoteDocUrl(note.version, docId)
      notifications.notify({
        severity: Severity.Warning,
        message: localize('releaseNotes.docMissing', '这个版本的文档未随应用提供：{docId}', {
          docId,
        }),
        ...(url !== undefined
          ? {
              actions: [
                {
                  label: localize('releaseNotes.docMissing.open', '在 GitHub 上查看该版本文档'),
                  run: () => openExternal(url),
                },
              ],
            }
          : {}),
      })
    },
    [note.version, notifications, openExternal],
  )

  const handleLink = useCallback<MarkdownLinkHandler>(
    (href, { toSide }) => {
      const target: ReleaseNoteHrefKind = classifyReleaseNoteHref(href)
      switch (target.kind) {
        case 'anchor':
          // In-page scrolling belongs to MarkdownView (declining is not a fallback
          // for anchors either).
          return false
        case 'doc': {
          if (isDocId(target.docId)) {
            const doc = new DocEditorInput(target.docId)
            if (groups) openDocInGroup(groups, doc, toSide)
            else void editorService.openEditor(doc, { activate: true, pinned: true })
            return true
          }
          reportMissingDoc(target.docId)
          return true
        }
        case 'command':
          void opener.open(`command:${target.commandId}`, {
            allowCommands: [target.commandId],
            fromUserGesture: true,
          })
          return true
        case 'external':
          openExternal(target.url)
          return true
        case 'invalid':
          notifications.notify({
            severity: Severity.Warning,
            message: localize('releaseNotes.linkRejected', '无法打开的链接：{reason}', {
              reason: target.reason,
            }),
          })
          return true
      }
    },
    [editorService, groups, notifications, openExternal, opener, reportMissingDoc],
  )

  return (
    <section
      className={styles['version'] ?? ''}
      data-testid="release-note-version"
      data-version={note.version}
      id={versionAnchor(note.version)}
    >
      {note.version !== '' && (
        <header className={styles['versionHeader'] ?? ''}>
          <h2 className={styles['versionTitle'] ?? ''}>{note.version}</h2>
          {note.title !== '' && <span className={styles['versionName'] ?? ''}>{note.title}</span>}
          {note.date !== undefined && (
            <time className={styles['versionDate'] ?? ''}>{note.date}</time>
          )}
          {note.summary !== '' && <p className={styles['versionSummary'] ?? ''}>{note.summary}</p>}
        </header>
      )}
      <MarkdownView
        text={note.body}
        className={styles['body'] ?? ''}
        extraHrefSchemes={MD_LINK_SCHEMES}
        linkHandler={handleLink}
      />
    </section>
  )
}

export function ReleaseNotesEditor({ input }: { input: IEditorInput }) {
  const notesInput = input as ReleaseNotesInput
  const notes = notesInput.notes
  const rootRef = useRef<HTMLDivElement>(null)

  const jumpTo = useCallback((version: string) => {
    const target = rootRef.current?.querySelector(`#${CSS.escape(versionAnchor(version))}`)
    target?.scrollIntoView({ block: 'start' })
  }, [])

  // A local index: the all-versions tab can hold every release the install knows.
  const index = useMemo(
    () => (notes.length > 1 ? notes.filter((note) => note.version !== '') : []),
    [notes],
  )

  return (
    <div className={styles['root']} data-testid="release-notes" ref={rootRef}>
      <div className={styles['banner'] ?? ''}>{notesInput.title}</div>
      {index.length > 0 && (
        <nav className={styles['index'] ?? ''} data-testid="release-notes-index">
          {index.map((note) => (
            <button
              key={note.version}
              type="button"
              className={styles['indexItem'] ?? ''}
              onClick={() => jumpTo(note.version)}
            >
              {note.version}
            </button>
          ))}
        </nav>
      )}
      {notes.length === 0 ? (
        <div className={styles['empty'] ?? ''}>
          {localize('releaseNotes.empty', 'No release notes are available.')}
        </div>
      ) : (
        notes.map((note, i) => <ReleaseNoteSection key={`${note.version}#${i}`} note={note} />)
      )}
    </div>
  )
}
