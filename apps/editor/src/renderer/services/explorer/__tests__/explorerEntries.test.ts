/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/explorer/explorerEntries.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IDirectoryEntry } from '@universe-editor/platform'
import {
  ENTRY_CHUNK_SIZE,
  childRelativePath,
  processDirectoryEntries,
  selectDirectoryEntries,
  sortDirectoryEntries,
} from '../explorerEntries.js'

const file = (name: string): IDirectoryEntry => ({ name, isFile: true, isDirectory: false })
const dir = (name: string): IDirectoryEntry => ({ name, isFile: false, isDirectory: true })

describe('explorerEntries — 目录项处理', () => {
  it('目录优先，文件名按自然数字序排列', async () => {
    const entries = [file('file10.ts'), dir('folder2'), file('file2.ts'), dir('folder10')]
    const processed = await processDirectoryEntries(entries, URI.file('/ws'), '')
    expect(processed.map((e) => e.name)).toEqual(['folder2', 'folder10', 'file2.ts', 'file10.ts'])
  })

  it('大小写/base 相等的文件名保持原稳定顺序', async () => {
    const names = ['README.md', 'readme.md', 'ReadMe.md']
    const processed = await processDirectoryEntries(names.map(file), URI.file('/ws'), '')
    expect(processed.map((e) => e.name)).toEqual(names)

    const reversed = [...names].reverse()
    const processedReversed = await processDirectoryEntries(reversed.map(file), URI.file('/ws'), '')
    expect(processedReversed.map((e) => e.name)).toEqual(reversed)
  })

  it('保留符号链接标记，目录链接仍排在文件前', async () => {
    const entries: IDirectoryEntry[] = [
      { name: 'link.txt', isFile: true, isDirectory: false, isSymbolicLink: true },
      { name: 'linkDir', isFile: false, isDirectory: true, isSymbolicLink: true },
      file('plain.txt'),
    ]
    const processed = await processDirectoryEntries(entries, URI.file('/ws'), '')
    expect(processed.map((e) => [e.name, e.isSymbolicLink ?? false])).toEqual([
      ['linkDir', true],
      ['link.txt', true],
      ['plain.txt', false],
    ])
  })

  it('按父目录 URI 拼接资源，Windows 与 remote URI 各自保留 scheme/authority', async () => {
    const win = URI.from({ scheme: 'file', path: '/C:/ws' })
    const remote = URI.parse('remote-ssh://dev/ws')
    for (const root of [win, remote]) {
      const parent = URI.joinPath(root, 'pkg')
      const processed = await processDirectoryEntries([file('a.ts'), dir('sub')], parent, 'pkg')
      expect(processed.map((e) => e.resource.toString())).toEqual([
        URI.joinPath(parent, 'sub').toString(),
        URI.joinPath(parent, 'a.ts').toString(),
      ])
      expect(processed[0]!.resource.scheme).toBe(root.scheme)
      expect(processed[0]!.resource.authority).toBe(root.authority)
    }
  })

  it('过滤得到父相对路径拼接出的完整相对路径', () => {
    const seen: Array<[string, boolean]> = []
    const entries = [dir('sub'), file('a.ts')]
    const kept = selectDirectoryEntries(entries, URI.file('/ws/pkg'), 'pkg', (rel, isDir) => {
      seen.push([rel, isDir])
      return true
    })
    expect(seen).toEqual([
      ['pkg/sub', true],
      ['pkg/a.ts', false],
    ])
    expect(kept).toHaveLength(2)

    expect(childRelativePath('', 'a')).toBe('a')
    expect(childRelativePath('pkg', 'a')).toBe('pkg/a')

    const filtered = selectDirectoryEntries(
      entries,
      URI.file('/ws/pkg'),
      '',
      (rel) => rel !== 'sub',
    )
    expect(filtered.map((e) => e.name)).toEqual(['a.ts'])
  })

  it('过滤在排序之前完成，被过滤项不参与输出', () => {
    const entries = [dir('a'), dir('z'), dir('m')]
    const kept = selectDirectoryEntries(entries, URI.file('/ws'), '', (rel) => rel !== 'z')
    expect(sortDirectoryEntries(kept).map((e) => e.name)).toEqual(['a', 'm'])
  })

  it('超大目录分片处理，结果与单次处理逐项一致', async () => {
    const count = ENTRY_CHUNK_SIZE * 2 + 3
    const entries: IDirectoryEntry[] = []
    for (let i = 0; i < count; i++) {
      // Two entries per name, differing only by case: keeps the stability
      // contract under test across chunk boundaries too.
      const name = `Item${(i * 37) % 977}${i % 2 === 0 ? '.ts' : '.TS'}`
      entries.push(i % 5 === 0 ? dir(name) : file(name))
    }
    const chunked = await processDirectoryEntries(entries, URI.file('/ws'), '')
    const single = sortDirectoryEntries(selectDirectoryEntries(entries, URI.file('/ws'), ''))
    expect(chunked.map((e) => e.name)).toEqual(single.map((e) => e.name))
  })

  it('回传单次同步排序耗时：小目录与分片目录都只回调一次', async () => {
    let smallCalls = 0
    let smallMs = -1
    await processDirectoryEntries([dir('b'), file('a')], URI.file('/ws'), '', undefined, (ms) => {
      smallCalls++
      smallMs = ms
    })
    expect(smallCalls).toBe(1)
    expect(smallMs).toBeGreaterThanOrEqual(0)

    const entries = Array.from({ length: ENTRY_CHUNK_SIZE + 1 }, (_, i) => file(`f${i}`))
    let chunkedCalls = 0
    await processDirectoryEntries(entries, URI.file('/ws'), '', undefined, () => {
      chunkedCalls++
    })
    expect(chunkedCalls).toBe(1)
  })
})
