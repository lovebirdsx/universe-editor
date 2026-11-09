import { describe, it, expect } from 'vitest'
import { URI, type IFileService } from '@universe-editor/platform'
import { EditorService } from '../EditorService.js'
import { DiffEditorInput } from '../DiffEditorInput.js'

const fileService = {} as IFileService

describe('EditorService diff reuse', () => {
  it('refreshes an already-open DiffEditorInput with the newer content', () => {
    const svc = new EditorService()
    const uri = URI.file('/tmp/foo.ts')

    const first = new DiffEditorInput(
      uri,
      'base-1',
      'current-1',
      undefined,
      undefined,
      false,
      fileService,
    )
    svc.openEditor(first, { pinned: false })

    let fired = 0
    first.onDidChangeContent(() => fired++)

    // File changes again; the view hands us a fresh input for the same resource.
    const second = new DiffEditorInput(
      uri,
      'base-2',
      'current-2',
      undefined,
      undefined,
      false,
      fileService,
    )
    svc.openEditor(second, { pinned: false })

    // The stale duplicate wins the identity check but must absorb the new content.
    expect(svc.openEditors.get().map((e) => e.id)).toEqual([first.id])
    expect(first.originalContent).toBe('base-2')
    expect(first.modifiedContent).toBe('current-2')
    expect(fired).toBe(1)
    expect(second.isDisposed).toBe(true)
  })

  it('adopts the origin of the incoming duplicate, in both directions', () => {
    const svc = new EditorService()
    const uri = URI.file('/tmp/foo.ts')

    const external = new DiffEditorInput(
      uri,
      'head',
      'worktree',
      undefined,
      undefined,
      true,
      fileService,
    )
    svc.openEditor(external, { pinned: false })
    expect(external.tracksSessionChanges).toBe(false)

    // Opening the same file from Session Changes reuses the tab and takes the
    // left side over with the tracker baseline.
    const session = new DiffEditorInput(
      uri,
      'baseline',
      'current',
      undefined,
      undefined,
      true,
      fileService,
    )
    session.setTracksSessionChanges(true)
    svc.openEditor(session, { pinned: false })
    expect(external.tracksSessionChanges).toBe(true)
    expect(external.originalContent).toBe('baseline')

    // Opening it again from SCM hands the tab back to the external diff.
    const externalAgain = new DiffEditorInput(
      uri,
      'head-2',
      'worktree-2',
      undefined,
      undefined,
      true,
      fileService,
    )
    svc.openEditor(externalAgain, { pinned: false })
    expect(external.tracksSessionChanges).toBe(false)
    expect(external.originalContent).toBe('head-2')
  })
})
