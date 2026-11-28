/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownReaderOverlays — the shared find-bar and link-hints overlays rendered
 *  on top of any markdown reading surface (file preview, doc center). Driven by
 *  the find / linkHints state from useMarkdownReaderNav. Both live in the same
 *  MarkdownPreviewEditor.module.css so the two surfaces look identical.
 *
 *  The host must position this as the first child of a `position: relative`
 *  scroll container; the link-hints layer is position:fixed to the viewport.
 *--------------------------------------------------------------------------------------------*/

import { type MutableRefObject } from 'react'
import { ChatFindWidget } from '../agents/ChatFindWidget.js'
import type { FindInContainerState } from './useFindInContainer.js'
import { LinkHintsOverlay } from '../markdown/linkHints/LinkHintsOverlay.js'
import type { MarkdownLinkHintsState } from '../markdown/linkHints/useMarkdownLinkHints.js'
import styles from './MarkdownPreviewEditor.module.css'

interface MarkdownReaderOverlaysProps<T extends HTMLElement> {
  readonly find: FindInContainerState
  readonly linkHints: MarkdownLinkHintsState
  /** The scroll container; focus returns here when the find bar closes so vim keys keep working. */
  readonly rootRef: MutableRefObject<T | null>
}

export function MarkdownReaderOverlays<T extends HTMLElement>({
  find,
  linkHints,
  rootRef,
}: MarkdownReaderOverlaysProps<T>) {
  return (
    <>
      {find.visible && (
        <ChatFindWidget
          className={styles['findWidget']}
          query={find.query}
          count={find.count}
          currentIndex={find.currentIndex}
          onQueryChange={find.setQuery}
          onNext={find.next}
          onPrev={find.prev}
          onClose={() => {
            find.close()
            rootRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
      <LinkHintsOverlay linkHints={linkHints} />
    </>
  )
}
