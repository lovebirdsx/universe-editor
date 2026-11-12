/*---------------------------------------------------------------------------------------------
 *  Tests for converting phone-sent prompt refs into desktop `PlacedRef`s.
 *  The phone only echoes suggestions this window produced, but the bridge still
 *  rebuilds file URIs from the session root and re-checks every range, so these
 *  cases cover both the happy paths and the forged/out-of-scope ones.
 *--------------------------------------------------------------------------------------------*/

import {
  normalizePlatform,
  URI,
  UriIdentityService,
  type IUriIdentityService,
} from '@universe-editor/platform'
import type { MobilePromptRef } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { toPlacedMobileRefs, type MobilePromptRefContext } from '../mobilePromptRefs.js'

const IDENTITY: IUriIdentityService = new UriIdentityService(normalizePlatform('linux'))

function context(overrides: Partial<MobilePromptRefContext> = {}): MobilePromptRefContext {
  return {
    mentionRoot: URI.file('/workspace'),
    uriIdentity: IDENTITY,
    docsRoots: ['/docs/user'],
    commitRoots: [URI.file('/workspace/repo')],
    ...overrides,
  }
}

function fileRef(overrides: Partial<MobilePromptRef> = {}): MobilePromptRef {
  return {
    kind: 'file',
    label: 'src/a.ts',
    uri: 'file:///workspace/src/a.ts',
    start: 5,
    end: 14,
    ...overrides,
  }
}

/** Simulates a version-skewed phone frame that omits an optional wire field. */
function withoutField(ref: MobilePromptRef, field: keyof MobilePromptRef): MobilePromptRef {
  const copy: Record<string, unknown> = { ...ref }
  delete copy[field]
  return copy as unknown as MobilePromptRef
}

describe('toPlacedMobileRefs files', () => {
  it('rebuilds the URI from the session root and keeps the range', () => {
    const result = toPlacedMobileRefs('look @src/a.ts', [fileRef()], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({
      start: 5,
      end: 14,
      ref: { kind: 'file', label: 'src/a.ts', uri: 'file:///workspace/src/a.ts' },
    })
  })

  it('rejects parent-directory traversal', () => {
    const ref = fileRef({ label: '../x', uri: 'file:///x', start: 0, end: 5 })
    expect(toPlacedMobileRefs('@../x', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects a URI that does not match the rebuilt path', () => {
    const ref = fileRef({ uri: 'file:///other/src/a.ts' })
    expect(toPlacedMobileRefs('look @src/a.ts', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects absolute and backslash paths', () => {
    const absolute = fileRef({ label: '/etc/passwd', uri: 'file:///etc/passwd', start: 0, end: 12 })
    expect(toPlacedMobileRefs('@/etc/passwd', [absolute], context())).toMatchObject({ ok: false })
    const backslash = fileRef({ label: 'src\\a.ts', uri: 'file:///workspace/src/a.ts' })
    expect(toPlacedMobileRefs('look @src\\a.ts', [backslash], context())).toMatchObject({
      ok: false,
    })
  })
})

describe('toPlacedMobileRefs context refs', () => {
  it('maps a symbol suggestion with its location metadata', () => {
    const ref: MobilePromptRef = {
      kind: 'symbol',
      label: 'fn',
      uri: 'file:///workspace/src/a.ts',
      description: 'src/a.ts:3',
      line: 3,
      column: 2,
      symbolKind: 11,
      start: 0,
      end: 3,
    }

    const result = toPlacedMobileRefs('#fn', [ref], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.ref).toMatchObject({
      kind: 'symbol',
      label: 'fn',
      meta: { line: 3, column: 2, symbolKind: 11, description: 'src/a.ts' },
    })
  })

  it('rejects context refs outside the session directory when narrowed', () => {
    const ref: MobilePromptRef = {
      kind: 'openEditor',
      label: 'out.ts',
      uri: 'file:///workspace/out.ts',
      start: 0,
      end: 7,
    }
    const narrowed = context({ mentionRoot: URI.file('/workspace/sub') })

    expect(toPlacedMobileRefs('#out.ts', [ref], narrowed)).toMatchObject({ ok: false })
  })

  it('rejects a workspace ref outside the root even when the session is not narrowed', () => {
    const ref: MobilePromptRef = {
      kind: 'scmChange',
      label: 'x.ts',
      uri: 'file:///other/x.ts',
      start: 0,
      end: 5,
    }
    expect(toPlacedMobileRefs('#x.ts', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects context refs from another scheme or authority', () => {
    const ref: MobilePromptRef = {
      kind: 'openEditor',
      label: 'out.ts',
      uri: 'vscode-remote://ssh-remote/workspace/out.ts',
      start: 0,
      end: 7,
    }
    expect(toPlacedMobileRefs('#out.ts', [ref], context())).toMatchObject({ ok: false })
  })
})

describe('toPlacedMobileRefs docs', () => {
  function docsRef(overrides: Partial<MobilePromptRef> = {}): MobilePromptRef {
    const dirPath = '/docs/user/zh-CN'
    return {
      kind: 'docs',
      label: 'Editor User Guide',
      uri: URI.file(dirPath).toString(),
      dirPath,
      start: 0,
      end: 18,
      ...overrides,
    }
  }

  it('accepts a directory inside a docs root', () => {
    const result = toPlacedMobileRefs('#Editor User Guide', [docsRef()], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.ref).toMatchObject({
      kind: 'docs',
      meta: { dirPath: '/docs/user/zh-CN' },
    })
  })

  it('rejects a directory outside every docs root', () => {
    const dirPath = '/tmp/docs'
    const ref = docsRef({ dirPath, uri: URI.file(dirPath).toString() })
    expect(toPlacedMobileRefs('#Editor User Guide', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects a docs ref whose URI does not match dirPath', () => {
    expect(
      toPlacedMobileRefs('#Editor User Guide', [docsRef({ uri: 'file:///tmp/docs' })], context()),
    ).toMatchObject({ ok: false })
  })
})

describe('toPlacedMobileRefs commit', () => {
  const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

  function commitRef(overrides: Partial<MobilePromptRef> = {}): MobilePromptRef {
    return {
      kind: 'commit',
      label: 'a1b2c3d fix login bug',
      uri: URI.file('/workspace/repo').toString(),
      commitHash: HASH,
      text: 'fix login bug',
      start: 0,
      end: 22,
      ...overrides,
    }
  }

  it('rebuilds a commit ref with the hash and subject', () => {
    const result = toPlacedMobileRefs('#a1b2c3d fix login bug', [commitRef()], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.ref).toMatchObject({
      kind: 'commit',
      label: 'a1b2c3d fix login bug',
      uri: URI.file('/workspace/repo').toString(),
      meta: { commitHash: HASH, description: 'fix login bug' },
    })
  })

  it('accepts a repo root above a narrowed session directory', () => {
    const narrowed = context({ mentionRoot: URI.file('/workspace/repo/sub') })

    const result = toPlacedMobileRefs('#a1b2c3d fix login bug', [commitRef()], narrowed)

    expect(result.ok).toBe(true)
  })

  it('rejects a repository outside the open git roots', () => {
    const ref = commitRef({ uri: URI.file('/workspace/other').toString() })

    expect(toPlacedMobileRefs('#a1b2c3d fix login bug', [ref], context())).toMatchObject({
      ok: false,
    })
  })

  it('rejects a missing or malformed hash', () => {
    const missing = withoutField(commitRef(), 'commitHash')
    const malformed = commitRef({ commitHash: 'not-hex' })

    expect(toPlacedMobileRefs('#a1b2c3d fix login bug', [missing], context())).toMatchObject({
      ok: false,
    })
    expect(toPlacedMobileRefs('#a1b2c3d fix login bug', [malformed], context())).toMatchObject({
      ok: false,
    })
  })

  it('rejects a missing subject', () => {
    const ref = withoutField(commitRef(), 'text')

    expect(toPlacedMobileRefs('#a1b2c3d fix login bug', [ref], context())).toMatchObject({
      ok: false,
    })
  })
})

describe('toPlacedMobileRefs chatContext', () => {
  function chatContextRef(overrides: Partial<MobilePromptRef> = {}): MobilePromptRef {
    return {
      kind: 'chatContext',
      label: 'CL 123',
      uri: '',
      text: 'Change 123\n- src/a.ts',
      start: 0,
      end: 7,
      ...overrides,
    }
  }

  it('passes the extension body through as a chatContext ref', () => {
    const result = toPlacedMobileRefs('#CL 123', [chatContextRef()], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.ref).toMatchObject({
      kind: 'chatContext',
      label: 'CL 123',
      uri: '',
      meta: { text: 'Change 123\n- src/a.ts' },
    })
  })

  it('rejects a chatContext ref that claims a resource', () => {
    const ref = chatContextRef({ uri: URI.file('/workspace/a.ts').toString() })

    expect(toPlacedMobileRefs('#CL 123', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects a missing body', () => {
    const ref = withoutField(chatContextRef(), 'text')

    expect(toPlacedMobileRefs('#CL 123', [ref], context())).toMatchObject({ ok: false })
  })
})

describe('toPlacedMobileRefs ranges', () => {
  it('rejects overlapping ranges', () => {
    const first = fileRef({ start: 0, end: 9 })
    const second = fileRef({ start: 5, end: 14 })
    expect(toPlacedMobileRefs('@src/a.ts @src/a.ts', [first, second], context())).toMatchObject({
      ok: false,
    })
  })

  it('rejects a stale range whose slice no longer matches', () => {
    const ref = fileRef({ start: 0, end: 9 })
    expect(toPlacedMobileRefs('@src/b.ts', [ref], context())).toMatchObject({ ok: false })
  })

  it('rejects ranges past the end of the text', () => {
    expect(toPlacedMobileRefs('look @src/a.ts', [fileRef({ end: 99 })], context())).toMatchObject({
      ok: false,
    })
  })

  it('returns refs sorted by start offset', () => {
    const file = fileRef({ start: 0, end: 9 })
    const symbol: MobilePromptRef = {
      kind: 'symbol',
      label: 'fn',
      uri: 'file:///workspace/src/a.ts',
      start: 14,
      end: 17,
    }

    const result = toPlacedMobileRefs('@src/a.ts and #fn', [symbol, file], context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((placed) => placed.start)).toEqual([0, 14])
  })
})
