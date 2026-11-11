import { normalizePlatform, URI, UriIdentityService } from '@universe-editor/platform'
import { MAX_IMAGE_SRC_LENGTH, MAX_MESSAGE_IMAGE_BYTES } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import {
  decodeBase64Bytes,
  imagePathToUri,
  isPathUnderAnyRoot,
  resolveImageRoots,
  resolveMarkdownImageCandidates,
  type MobileImagePathContext,
} from '../mobileImagePath.js'

const linux = new UriIdentityService(normalizePlatform('linux'))
const windows = new UriIdentityService(normalizePlatform('win32'))

function context(overrides: Partial<MobileImagePathContext> = {}): MobileImagePathContext {
  return {
    cwd: '/workspace/demo',
    authority: undefined,
    workspaceFolder: URI.file('/workspace/demo'),
    identity: linux,
    ...overrides,
  }
}

describe('resolveImageRoots', () => {
  it('uses the session cwd and skips a nested workspace folder', () => {
    expect(resolveImageRoots(context())).toEqual(['/workspace/demo'])
    expect(resolveImageRoots(context({ workspaceFolder: undefined }))).toEqual(['/workspace/demo'])
  })

  it('rejects a workspace folder on a different host', () => {
    expect(
      resolveImageRoots(context({ authority: 'ssh-remote+host', cwd: '/home/dev/proj' })),
    ).toEqual(['/home/dev/proj'])
    expect(
      resolveImageRoots(
        context({
          cwd: undefined,
          authority: 'ssh-remote+host',
          workspaceFolder: URI.file('/workspace/demo'),
        }),
      ),
    ).toEqual([])
    expect(
      resolveImageRoots(
        context({
          cwd: undefined,
          authority: 'ssh-remote+host',
          workspaceFolder: URI.from({
            scheme: 'remote-ssh',
            authority: 'ssh-remote+host',
            path: '/home/dev/proj',
          }),
        }),
      ),
    ).toEqual(['/home/dev/proj'])
  })
})

describe('resolveMarkdownImageCandidates', () => {
  it('resolves relative, absolute and file: sources inside the cwd', () => {
    expect(resolveMarkdownImageCandidates('img/shot.png', context())).toEqual([
      {
        uri: URI.file('/workspace/demo/img/shot.png'),
        fsPath: '/workspace/demo/img/shot.png',
        mimeType: 'image/png',
      },
    ])
    expect(resolveMarkdownImageCandidates('/workspace/demo/a.jpg', context())).toEqual([
      {
        uri: URI.file('/workspace/demo/a.jpg'),
        fsPath: '/workspace/demo/a.jpg',
        mimeType: 'image/jpeg',
      },
    ])
    expect(resolveMarkdownImageCandidates('file:///workspace/demo/b.webp', context())).toEqual([
      {
        uri: URI.file('/workspace/demo/b.webp'),
        fsPath: '/workspace/demo/b.webp',
        mimeType: 'image/webp',
      },
    ])
  })

  it('adds a percent-decoded variant and dedupes it', () => {
    const candidates = resolveMarkdownImageCandidates('img/my%20shot.png', context())
    expect(candidates.map((candidate) => candidate.fsPath)).toEqual([
      '/workspace/demo/img/my%20shot.png',
      '/workspace/demo/img/my shot.png',
    ])
    expect(resolveMarkdownImageCandidates('img/shot.png', context())).toHaveLength(1)
  })

  it('resolves drive paths only for local sessions', () => {
    const local = context({
      cwd: 'C:/work',
      workspaceFolder: URI.file('C:/work'),
      identity: windows,
    })
    expect(resolveMarkdownImageCandidates('C:\\work\\pics\\a.png', local)).toEqual([
      {
        uri: URI.file('C:/work/pics/a.png'),
        fsPath: 'C:/work/pics/a.png',
        mimeType: 'image/png',
      },
    ])
    const remote = context({ authority: 'ssh-remote+host', cwd: '/home/dev' })
    expect(resolveMarkdownImageCandidates('C:\\pics\\a.png', remote)).toEqual([])
  })

  it('rejects remote sources, other schemes and dangerous path shapes', () => {
    const ctx = context()
    for (const src of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/png;base64,AAA=',
      'blob:https://example.com/x',
      'vscode-remote://x/y.png',
      '\\\\server\\share\\a.png',
      '//server/share/a.png',
      'C:relative.png',
      'notes.txt',
      '',
      'x'.repeat(MAX_IMAGE_SRC_LENGTH + 1),
    ]) {
      expect(resolveMarkdownImageCandidates(src, ctx), src).toEqual([])
    }
  })

  it('rejects traversal and paths outside every root', () => {
    expect(resolveMarkdownImageCandidates('../../etc/passwd.png', context())).toEqual([])
    expect(resolveMarkdownImageCandidates('/tmp/outside.png', context())).toEqual([])
    expect(resolveMarkdownImageCandidates('/workspace/other/a.png', context())).toEqual([])
    expect(
      resolveMarkdownImageCandidates(
        'a.png',
        context({ cwd: undefined, workspaceFolder: undefined }),
      ),
    ).toEqual([])
  })

  it('builds remote-ssh resources for remote sessions and rejects file: there', () => {
    const remote = context({ authority: 'ssh-remote+host', cwd: '/home/dev/proj' })
    expect(resolveMarkdownImageCandidates('img/a.png', remote)).toEqual([
      {
        uri: URI.from({
          scheme: 'remote-ssh',
          authority: 'ssh-remote+host',
          path: '/home/dev/proj/img/a.png',
        }),
        fsPath: '/home/dev/proj/img/a.png',
        mimeType: 'image/png',
      },
    ])
    expect(resolveMarkdownImageCandidates('file:///home/dev/proj/img/a.png', remote)).toEqual([])
  })
})

describe('isPathUnderAnyRoot', () => {
  it('accepts nesting and rejects escapes', () => {
    expect(isPathUnderAnyRoot('/workspace/demo/a.png', ['/workspace/demo'], linux)).toBe(true)
    expect(isPathUnderAnyRoot('/workspace/demo', ['/workspace/demo'], linux)).toBe(true)
    expect(isPathUnderAnyRoot('/workspace/demo/../etc/a.png', ['/workspace/demo'], linux)).toBe(
      false,
    )
  })
})

describe('decodeBase64Bytes', () => {
  it('decodes base64 and strips data: prefixes', () => {
    expect(decodeBase64Bytes('AQID', 16)).toEqual(new Uint8Array([1, 2, 3]))
    expect(decodeBase64Bytes('data:image/png;base64,AQID', 16)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects invalid payloads and oversized data before decoding', () => {
    expect(decodeBase64Bytes('', 16)).toBeUndefined()
    expect(decodeBase64Bytes('not base64!', 16)).toBeUndefined()
    expect(decodeBase64Bytes('AQID', 2)).toBeUndefined()
    expect(
      decodeBase64Bytes('A'.repeat(MAX_MESSAGE_IMAGE_BYTES + 1), MAX_MESSAGE_IMAGE_BYTES),
    ).toBeUndefined()
  })
})

describe('imagePathToUri', () => {
  it('uses file: locally and remote-ssh: for an authority', () => {
    expect(imagePathToUri('/a/b.png', undefined).toString()).toBe('file:///a/b.png')
    expect(imagePathToUri('/a/b.png', 'ssh-remote+host').scheme).toBe('remote-ssh')
    expect(imagePathToUri('/a/b.png', 'ssh-remote+host').authority).toBe('ssh-remote+host')
  })
})
