/*---------------------------------------------------------------------------------------------
 *  Tests for computeMarkdownLinkInsert: the uri-list branch must produce a path
 *  relative to the *target* markdown document's directory, not the workspace
 *  root — otherwise dropping a file into a markdown doc that lives outside the
 *  workspace root produces a broken link.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  computeMarkdownLinkInsert,
  URI_LIST_MIME,
  type IVSDataTransfer,
  type MarkdownLinkContext,
} from '../markdownLinkProviderShared.js'

function uriListTransfer(raw: string): IVSDataTransfer {
  return {
    get: (mime: string) => (mime === URI_LIST_MIME ? { asString: async () => raw } : undefined),
  }
}

const ROOT = 'C:/work/project'

function ctx(overrides: Partial<MarkdownLinkContext> = {}): MarkdownLinkContext {
  return {
    workspaceFolderFsPath: ROOT,
    platform: 'win32',
    fileService: {
      createDirectory: async () => {},
      writeFile: async () => {},
      exists: async () => false,
    },
    ...overrides,
  }
}

describe('computeMarkdownLinkInsert — uri-list', () => {
  it('is relative to the workspace root when the target markdown is also at the root', async () => {
    const target = URI.file(`${ROOT}/target.md`).toString()
    const raw = 'file:///C:/work/project/a.md'
    const snippet = await computeMarkdownLinkInsert(
      uriListTransfer(raw),
      target,
      ctx(),
      () => false,
    )
    expect(snippet).toBe('[${1:text}](a.md)')
  })

  it('is relative to the target markdown document directory, not the workspace root', async () => {
    // Target markdown lives two levels below the workspace root; the dropped
    // file lives directly under the root, as a sibling of the target's parent.
    const target = URI.file(`${ROOT}/docs/sub/target.md`).toString()
    const raw = 'file:///C:/work/project/docs/a.md'
    const snippet = await computeMarkdownLinkInsert(
      uriListTransfer(raw),
      target,
      ctx(),
      () => false,
    )
    // From docs/sub/, docs/a.md is one level up: ../a.md.
    expect(snippet).toBe('[${1:text}](../a.md)')
  })

  it('climbs multiple levels and back down when the target and source diverge', async () => {
    const target = URI.file(`${ROOT}/a/b/target.md`).toString()
    const raw = 'file:///C:/work/project/c/d/img.png'
    const snippet = await computeMarkdownLinkInsert(
      uriListTransfer(raw),
      target,
      ctx(),
      () => false,
    )
    expect(snippet).toBe('![${1:alt text}](../../c/d/img.png)')
  })
})
