/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ReleaseNotesEditor — one section per version: a header (version / date / title /
 *  summary) plus the version's markdown body rendered by the shared MarkdownView.
 *
 *  Release notes are the one consumer allowed to link with `doc:` / `command:`, and
 *  this editor is the only place that grants it. "Missing doc" is NOT resolved against
 *  the running install: each body section's own version decides the GitHub fallback
 *  (a merged patch pins to the patch's tag), so a note about 0.12.0 can never link at
 *  main or at the current release.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useRef } from 'react'
import {
  IEditorGroupsService,
  IEditorInput,
  IEditorService,
  IInstantiationService,
  IOpenerService,
  INotificationService,
  IUriIdentityService,
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
import { openDocInGroup, openDocWithTarget } from '../../services/editor/openDoc.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { ReleaseNotesInput } from '../../services/editor/ReleaseNotesInput.js'
import { splitNoteBodySections } from '../../services/releaseNotes/releaseNotes.js'
import { useService } from '../useService.js'
import { MarkdownView, type MarkdownLinkHandler } from '../markdown/MarkdownView.js'
import { useEditorGroup } from './EditorGroupContext.js'
import styles from './ReleaseNotesEditor.module.css'

const MD_LINK_SCHEMES = releaseNoteHrefSchemes()

function versionAnchor(version: string): string {
  return `version-${version.replace(/[^A-Za-z0-9]+/g, '-')}`
}

/**
 * 一段正文：缺文档的链接按该段自己的版本回退。合并稿的分段来自编译器输出的 bodySections
 * 偏移，补丁段因此固定到补丁 tag；随包文档两边都本地打开。
 */
function NoteBody({ markdown, version }: { readonly markdown: string; readonly version: string }) {
  const groups = useEditorGroup()
  const editorService = useService(IEditorService)
  const editorGroups = useService(IEditorGroupsService)
  const inst = useService(IInstantiationService)
  const uriIdentity = useService(IUriIdentityService)
  const aux = useService(IAuxiliaryEditorWindowService)
  const targets = useMemo(
    () => ({ groups: editorGroups, inst, uriIdentity, aux }),
    [editorGroups, inst, uriIdentity, aux],
  )
  const opener = useService(IOpenerService)
  const notifications = useService(INotificationService)

  const openExternal = useCallback(
    (url: string) => {
      void opener.open(url, { fromUserGesture: true })
    },
    [opener],
  )

  // 随包未提供的文档：用该段自己的版本给 GitHub 回退链接。
  const reportMissingDoc = useCallback(
    (docId: string) => {
      const url = version === '' ? undefined : releaseNoteDocUrl(version, docId)
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
    [version, notifications, openExternal],
  )

  const handleLink = useCallback<MarkdownLinkHandler>(
    (href, { target: openTarget }) => {
      const target: ReleaseNoteHrefKind = classifyReleaseNoteHref(href)
      switch (target.kind) {
        case 'anchor':
          // In-page scrolling belongs to MarkdownView (declining is not a fallback
          // for anchors either).
          return false
        case 'doc': {
          if (isDocId(target.docId)) {
            const createDoc = (): DocEditorInput => new DocEditorInput(target.docId)
            const doc = createDoc()
            if (openTarget === 'default') {
              if (groups) openDocInGroup(groups, doc, false)
              else void editorService.openEditor(doc, { activate: true, pinned: true })
              return true
            }
            void openDocWithTarget(targets, doc, openTarget, groups ?? undefined).then((result) => {
              if (result.handled) return
              openDocInGroup(
                groups ?? editorGroups.openTargetGroup,
                doc.isDisposed ? createDoc() : doc,
                false,
              )
            })
            return true
          }
          reportMissingDoc(target.docId)
          return true
        }
        case 'command':
          void opener.open(`command:${target.commandId}`, {
            allowCommands: [target.commandId],
            fromUserGesture: true,
            ...(openTarget === 'side' ? { openToSide: true } : {}),
            ...(openTarget === 'newWindow' ? { openInNewWindow: true } : {}),
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
    [
      editorService,
      editorGroups,
      groups,
      notifications,
      openExternal,
      opener,
      reportMissingDoc,
      targets,
    ],
  )

  return (
    <MarkdownView
      text={markdown}
      className={styles['body'] ?? ''}
      extraHrefSchemes={MD_LINK_SCHEMES}
      linkHandler={handleLink}
    />
  )
}

function ReleaseNoteSection({ note }: { readonly note: IReleaseNote }) {
  const sections = useMemo(
    () => splitNoteBodySections(note.body, note.version, note.bodySections),
    [note.body, note.version, note.bodySections],
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
      {sections.map((section, i) => (
        <NoteBody key={i} markdown={section.markdown} version={section.version} />
      ))}
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
