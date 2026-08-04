/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/telemetry/errorFingerprint.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  computeErrorFingerprint,
  computeStackKey,
  normalizeStackPath,
  parseStackFrames,
  shortStackPath,
} from '../../telemetry/errorFingerprint.js'

const WIN_STACK = [
  'Error: boom',
  '    at sendPrompt (D:\\git_project\\universe-editor\\apps\\editor\\src\\renderer\\services\\acp\\session\\acpSession.ts:412:15)',
  '    at async run (D:\\git_project\\universe-editor\\packages\\platform\\dist\\command\\commandService.js:88:7)',
].join('\n')

const POSIX_STACK = [
  'TypeError: Cannot read properties of undefined',
  '    at /home/ci/agent/project/dist/main/index.js:10:5',
  '    at file:///home/ci/agent/project/node_modules/pkg/lib/helper.js:22:11',
].join('\n')

describe('parseStackFrames', () => {
  it('parses frames with function names (Windows paths)', () => {
    const frames = parseStackFrames(WIN_STACK)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({
      func: 'sendPrompt',
      location:
        'D:\\git_project\\universe-editor\\apps\\editor\\src\\renderer\\services\\acp\\session\\acpSession.ts',
      line: 412,
    })
  })

  it('parses anonymous frames and file:// URLs', () => {
    const frames = parseStackFrames(POSIX_STACK)
    expect(frames).toHaveLength(2)
    expect(frames[0]?.func).toBeUndefined()
    expect(frames[1]?.location).toBe('file:///home/ci/agent/project/node_modules/pkg/lib/helper.js')
  })

  it('parses node-internal frames', () => {
    const frames = parseStackFrames('Error: x\n    at node:internal/modules/cjs/loader:1105:14')
    expect(frames[0]?.location).toBe('node:internal/modules/cjs/loader')
    expect(frames[0]?.line).toBe(1105)
  })

  it('skips the message line and unparseable lines', () => {
    expect(parseStackFrames('Error: just a message')).toHaveLength(0)
  })
})

describe('normalizeStackPath', () => {
  it('unifies separators and strips file:// + query', () => {
    expect(normalizeStackPath('file:///C:/foo/bar.ts?x=1')).toBe('C:/foo/bar.ts')
    expect(normalizeStackPath('D:\\a\\b\\c.ts')).toBe('D:/a/b/c.ts')
    expect(normalizeStackPath('/home/u/p/f.ts#frag')).toBe('/home/u/p/f.ts')
  })
})

describe('shortStackPath', () => {
  it('keeps the last two segments', () => {
    expect(shortStackPath('D:\\git_project\\universe-editor\\packages\\platform\\dist\\x.js')).toBe(
      'dist/x.js',
    )
    expect(shortStackPath('file:///a/b/c/d.ts')).toBe('c/d.ts')
  })
})

describe('computeStackKey', () => {
  it('is identical for identical stacks regardless of path roots', () => {
    const otherRoot = WIN_STACK.replaceAll('D:\\git_project\\universe-editor', 'E:\\other\\root')
    expect(computeStackKey(otherRoot)).toBe(computeStackKey(WIN_STACK))
  })

  it('differs when a line number differs', () => {
    const shifted = WIN_STACK.replace('acpSession.ts:412:15', 'acpSession.ts:413:15')
    expect(computeStackKey(shifted)).not.toBe(computeStackKey(WIN_STACK))
  })
})

describe('computeErrorFingerprint', () => {
  it('uses the first frame func@shortPath', () => {
    expect(computeErrorFingerprint(WIN_STACK, 'boom')).toBe('sendPrompt@session/acpSession.ts')
  })

  it('falls back to a normalized message for stackless errors', () => {
    const fp = computeErrorFingerprint(undefined, "ENOENT: open 'C:\\Users\\kuro\\x.txt' failed")
    expect(fp).not.toContain('kuro')
    expect(fp).not.toContain('C:')
  })

  it('strips digits from message fallback so repeats collapse', () => {
    const a = computeErrorFingerprint(undefined, 'timeout after 1024 ms')
    const b = computeErrorFingerprint(undefined, 'timeout after 2048 ms')
    expect(a).toBe(b)
  })

  it('caps message fallback length', () => {
    const fp = computeErrorFingerprint(undefined, 'x'.repeat(200))
    expect(fp.length).toBeLessThanOrEqual(80)
  })
})
