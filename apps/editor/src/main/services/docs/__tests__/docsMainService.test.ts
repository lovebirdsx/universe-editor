/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for DocsMainService — reads each doc category (docs/user/ and
 *  docs/extension-dev/) as locale trees of markdown files off disk, keys them
 *  by locale-relative path (no .md), and degrades to an empty map when a
 *  locale directory is absent.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocCategory } from '../../../../shared/ipc/docsService.js'
import { DocsMainService } from '../docsMainService.js'

describe('DocsMainService', () => {
  let root: string
  const resolver = () => root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ue-docs-svc-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(rel: string, content: string): void {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }

  it('reads nested .md files keyed by locale-relative path without .md', async () => {
    write('zh-CN/index.md', '# 首页')
    write('zh-CN/getting-started/interface-tour.md', '# 界面导览')

    const docs = await new DocsMainService(resolver).getDocs()

    expect(docs.user['zh-CN']?.['index']).toBe('# 首页')
    expect(docs.user['zh-CN']?.['getting-started/interface-tour']).toBe('# 界面导览')
  })

  it('ignores non-markdown files', async () => {
    write('zh-CN/index.md', '# 首页')
    write('zh-CN/assets/screenshot.png', 'binary')

    const docs = await new DocsMainService(resolver).getDocs()

    expect(Object.keys(docs.user['zh-CN'] ?? {})).toEqual(['index'])
  })

  it('degrades to an empty map for a missing locale directory', async () => {
    write('zh-CN/index.md', '# 首页')

    const docs = await new DocsMainService(resolver).getDocs()

    expect(docs.user['zh-CN']?.['index']).toBe('# 首页')
    expect(docs.user['en-US']).toEqual({})
  })

  it('reads every category from its own root', async () => {
    write('user/zh-CN/index.md', '# 用户文档')
    write('extension-dev/zh-CN/README.md', '# 扩展开发')

    const docs = await new DocsMainService((category: DocCategory) =>
      join(root, category === 'user' ? 'user' : 'extension-dev'),
    ).getDocs()

    expect(docs.user['zh-CN']?.['index']).toBe('# 用户文档')
    expect(docs.extensionDev['zh-CN']?.['README']).toBe('# 扩展开发')
    expect(docs.extensionDev['zh-CN']?.['index']).toBeUndefined()
  })

  it('caches the result across calls', async () => {
    write('zh-CN/index.md', '# 首页')
    const svc = new DocsMainService(resolver)

    const first = await svc.getDocs()
    write('zh-CN/late.md', '# 迟到')
    const second = await svc.getDocs()

    expect(second).toBe(first)
    expect(second.user['zh-CN']?.['late']).toBeUndefined()
  })

  it('getDocsRoot returns the resolved root for each category', async () => {
    const svc = new DocsMainService((category) => join(root, category))
    expect(await svc.getDocsRoot('user')).toBe(join(root, 'user'))
    expect(await svc.getDocsRoot('extensionDev')).toBe(join(root, 'extensionDev'))
  })
})
