/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: the same markdown file is open in two split groups, both cursors on
 *  line 1. Opening the preview in place (Ctrl+Shift+V) in the LEFT group detaches
 *  the left source tab and aligns the preview to the source cursor line — which
 *  programmatically scrolls the preview. The two-way scroll sync, if left on in
 *  this in-place toggle mode, walked *all* groups looking for a source editor of
 *  the same URI, latched onto the RIGHT group's unrelated split and drove its
 *  scroll from the preview's — visibly yanking the right editor to the bottom.
 *
 *  The fix gates the sync off whenever the preview holds the source input (toggle
 *  mode). Here we drive the hook directly with `enabled: false` and assert it
 *  never touches the other group's editor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import {
  IEditorGroupsService,
  IFileService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  UriIdentityService,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { useMarkdownSyncScroll } from '../useMarkdownSyncScroll.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import { ServicesContext } from '../../useService.js'

const SOURCE_URI = URI.file('/repo/doc.md')

function makeFakeFileService(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function makeInstantiation() {
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  services.set(IFileService, makeFakeFileService())
  return { inst: new InstantiationService(services), groups }
}

// Minimal fake standalone editor: only the members the sync path reads. If the
// sync (wrongly) engages, it calls setScrollTop — which we assert never happens.
function makeFakeEditor() {
  const setScrollTop = vi.fn()
  const editor = {
    setScrollTop,
    getScrollTop: () => 0,
    getVisibleRanges: () => [{ startLineNumber: 1 }],
    getTopForLineNumber: (n: number) => n * 20,
    getBottomForLineNumber: (n: number) => n * 20 + 20,
    getLayoutInfo: () => ({ height: 400 }),
    getModel: () => ({ getLineCount: () => 100 }),
    onDidScrollChange: () => ({ dispose() {} }),
  }
  return { editor, setScrollTop }
}

// A scroll container that renders `data-line` blocks so collectEntries maps lines
// to pixels, mirroring MarkdownPreviewEditor's laid-out preview.
function Host({ enabled }: { enabled: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  useMarkdownSyncScroll(rootRef, SOURCE_URI, enabled)
  return (
    <div ref={rootRef} data-testid="preview">
      <div>
        {Array.from({ length: 20 }, (_, i) => (
          <p key={i} data-line={i}>
            paragraph {i}
          </p>
        ))}
      </div>
    </div>
  )
}

function stubGeometry(root: HTMLElement): void {
  root.getBoundingClientRect = (() => ({ top: 0 }) as DOMRect) as never
  Object.defineProperty(root, 'scrollHeight', { value: 2000, configurable: true })
  Object.defineProperty(root, 'clientHeight', { value: 400, configurable: true })
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-line]'))
  blocks.forEach((b, i) => {
    b.getBoundingClientRect = (() => ({ top: i * 20 }) as DOMRect) as never
  })
}

describe('useMarkdownSyncScroll — in-place toggle must not drive another group', () => {
  afterEach(() => {
    cleanup()
    FileEditorRegistry._resetForTests()
  })

  function setupTwoSplits() {
    const { inst, groups } = makeInstantiation()
    // Left group holds the source; right group is a split of the same file.
    const leftSource = inst.createInstance(FileEditorInput, SOURCE_URI)
    const rightGroup = groups.addGroup(groups.activeGroup, 3 /* GroupDirection.Right */)
    const rightSource = inst.createInstance(FileEditorInput, SOURCE_URI)
    rightGroup.openEditor(rightSource, { activate: true, pinned: true })

    // Toggle mode: the left source tab was detached when the preview replaced it,
    // so only the RIGHT group still has a mounted FileEditorInput for this URI.
    const { editor, setScrollTop } = makeFakeEditor()
    FileEditorRegistry.register(rightSource, editor as never, rightGroup.id)

    return { inst, leftSource, setScrollTop }
  }

  it('does not scroll the other group’s editor when sync is disabled (toggle mode)', () => {
    const { inst, setScrollTop } = setupTwoSplits()

    const { container } = render(
      <ServicesContext.Provider value={inst}>
        <Host enabled={false} />
      </ServicesContext.Provider>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!
    stubGeometry(root)

    // Programmatic reveal-to-cursor scroll of the preview (as on Ctrl+Shift+V).
    act(() => {
      root.scrollTop = 1600
      root.dispatchEvent(new Event('scroll'))
    })

    expect(setScrollTop).not.toHaveBeenCalled()
  })

  it('regression guard: with sync enabled it WOULD grab the other group’s editor', () => {
    const { inst, setScrollTop } = setupTwoSplits()

    const { container } = render(
      <ServicesContext.Provider value={inst}>
        <Host enabled={true} />
      </ServicesContext.Provider>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!
    stubGeometry(root)

    act(() => {
      root.scrollTop = 1600
      root.dispatchEvent(new Event('scroll'))
    })

    // Demonstrates the bug the `enabled` gate prevents: the unrelated split gets
    // driven. This is the exact behaviour the toggle-mode gate suppresses.
    expect(setScrollTop).toHaveBeenCalled()
  })
})
