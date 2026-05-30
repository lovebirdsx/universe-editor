import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { diffModelUri } from '../diffModelUri.js'

describe('diffModelUri', () => {
  const original = URI.file('D:/git_project/universe-editor/apps/editor/src/main/windowState.ts')

  it('只替换 scheme，保留干净的资源 path', () => {
    expect(diffModelUri(original, 'original').scheme).toBe('diff-original')
    expect(diffModelUri(original, 'modified').scheme).toBe('diff-modified')

    for (const side of ['original', 'modified'] as const) {
      expect(diffModelUri(original, side).path).toBe(
        '/D:/git_project/universe-editor/apps/editor/src/main/windowState.ts',
      )
    }
  })

  // 复现 "Could not find source file" 的根因：旧实现把整个 file:// URI 字符串拼进
  // path（diff-modified:file:///D:/…），TS worker 拿到畸形 URI 后无法定位源文件。
  it('path 不得嵌套 file scheme，URI 字符串可无损 round-trip', () => {
    const uri = diffModelUri(original, 'modified')

    expect(uri.path).not.toContain('file:')
    expect(uri.toString()).not.toContain('file%3A')
    expect(uri.toString()).not.toContain('file:///')

    const reparsed = URI.parse(uri.toString())
    expect(reparsed.scheme).toBe(uri.scheme)
    expect(reparsed.path).toBe(uri.path)
  })

  it('对照：旧的字符串拼接方式产生畸形的嵌套 URI', () => {
    const legacy = URI.parse(`diff-modified:${original.toString()}`)
    expect(legacy.path).toContain('file:///')
  })
})
