/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire-boundary pull cache regression tests. Symbol/lens responses for a large
 *  file are multi-MB frames — re-attaching a model (tab switch) must not re-pull
 *  them for an unchanged model version, regardless of which Monaco consumer asks.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { DisposableStore, Emitter } from '@universe-editor/platform'
import type { IExtHostLanguages } from '@universe-editor/extensions-common'
import { PendingDocumentSync } from '../../extensions/PendingDocumentSync.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import {
  createCodeActionProxy,
  createCodeLensProxy,
  createDocumentRangeFormattingProxy,
  createDocumentSymbolProxy,
  createInlayHintsProxy,
  createOnTypeFormattingProxy,
} from '../languageProviderProxy.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { get: () => ({}), peek: () => undefined },
}))

function makeModel(uri: string, versionId = 1): monaco.editor.ITextModel {
  return {
    uri: { toString: () => uri },
    getVersionId: () => versionId,
  } as unknown as monaco.editor.ITextModel
}

describe('code action 文档版本一致性', () => {
  const uri = 'file:///workspace/error.ts'
  function setup() {
    let version = 1
    let disposed = false
    const model = {
      ...makeModel(uri),
      getVersionId: () => version,
      isDisposed: () => disposed,
    } as monaco.editor.ITextModel
    const token = { isCancellationRequested: false } as monaco.CancellationToken
    const pull = vi.fn().mockResolvedValue([{ title: '正常重构', kind: 'refactor' }])
    const proxy = createCodeActionProxy(1, {
      $provideCodeActions: pull,
    } as unknown as IExtHostLanguages)
    const request = () =>
      proxy.provideCodeActions(
        model,
        {
          startLineNumber: 3,
          endLineNumber: 3,
          startColumn: 28,
          endColumn: 28,
        } as monaco.Range,
        { markers: [], trigger: 1, only: 'refactor' },
        token,
      )
    return {
      pull,
      token,
      request,
      change: () => {
        version++
      },
      dispose: () => {
        disposed = true
      },
    }
  }

  it('镜像同步完成前不发请求，正常响应保留过滤条件', async () => {
    let resume!: () => void
    PendingDocumentSync.register(
      uri,
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    try {
      const h = setup()
      const pending = h.request()
      expect(h.pull).not.toHaveBeenCalled()
      resume()
      const result = await pending
      expect(result?.actions[0]?.title).toBe('正常重构')
      expect(h.pull).toHaveBeenCalledWith(
        1,
        expect.anything(),
        {
          start: { line: 2, character: 27 },
          end: { line: 2, character: 27 },
        },
        { only: ['refactor'] },
      )
    } finally {
      PendingDocumentSync.unregister(uri)
    }
  })

  it.each(['change', 'cancel', 'dispose'])('同步等待期间 %s 不发送旧 range', async (reason) => {
    let resume!: () => void
    PendingDocumentSync.register(
      uri,
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    try {
      const h = setup()
      const pending = h.request()
      if (reason === 'change') h.change()
      if (reason === 'dispose') h.dispose()
      if (reason === 'cancel')
        (h.token as { isCancellationRequested: boolean }).isCancellationRequested = true
      resume?.()
      expect(await pending).toBeNull()
      expect(h.pull).not.toHaveBeenCalled()
    } finally {
      PendingDocumentSync.unregister(uri)
    }
  })

  it('同步失败不继续请求', async () => {
    const error = new Error('同步失败')
    PendingDocumentSync.register(uri, async () => {
      throw error
    })
    try {
      const h = setup()
      await expect(h.request()).rejects.toBe(error)
      expect(h.pull).not.toHaveBeenCalled()
    } finally {
      PendingDocumentSync.unregister(uri)
    }
  })

  it('文档变化后不返回旧 edits', async () => {
    const h = setup()
    h.pull.mockImplementation(async () => {
      h.change()
      return [{ title: '旧修复' }]
    })
    expect(await h.request()).toBeNull()
  })
})

const lspSymbol = {
  name: 'A',
  kind: 5,
  range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
  selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
}

const lspLens = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }

/** Monaco 1-based IRange → the LSP 0-based shape expected on the wire. */
function rangeToLsp(r: monaco.IRange) {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  }
}

describe('createDocumentSymbolProxy pull cache', () => {
  it('serves an unchanged model version from cache (one wire pull)', async () => {
    const pull = vi.fn().mockResolvedValue([lspSymbol])
    const proxy = createDocumentSymbolProxy(1, {
      $provideDocumentSymbols: pull,
    } as unknown as IExtHostLanguages)

    const model = makeModel('file:///a.ts')
    const first = await proxy.provideDocumentSymbols(model, null as never)
    const second = await proxy.provideDocumentSymbols(model, null as never)
    expect(pull).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('re-pulls when the model version changes', async () => {
    const pull = vi.fn().mockResolvedValue([lspSymbol])
    const proxy = createDocumentSymbolProxy(1, {
      $provideDocumentSymbols: pull,
    } as unknown as IExtHostLanguages)

    await proxy.provideDocumentSymbols(makeModel('file:///a.ts', 1), null as never)
    await proxy.provideDocumentSymbols(makeModel('file:///a.ts', 2), null as never)
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent pulls for the same version onto one wire call', async () => {
    let resolve!: (v: (typeof lspSymbol)[]) => void
    const pull = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)))
    const proxy = createDocumentSymbolProxy(1, {
      $provideDocumentSymbols: pull,
    } as unknown as IExtHostLanguages)

    const model = makeModel('file:///a.ts')
    const p1 = proxy.provideDocumentSymbols(model, null as never)
    const p2 = proxy.provideDocumentSymbols(model, null as never)
    expect(pull).toHaveBeenCalledTimes(1)
    resolve([lspSymbol])
    expect(await p2).toEqual(await p1)
  })

  it('does not cache empty results (server still warming up)', async () => {
    const pull = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([lspSymbol])
    const proxy = createDocumentSymbolProxy(1, {
      $provideDocumentSymbols: pull,
    } as unknown as IExtHostLanguages)

    const model = makeModel('file:///a.ts')
    expect(await proxy.provideDocumentSymbols(model, null as never)).toEqual([])
    const second = await proxy.provideDocumentSymbols(model, null as never)
    expect(pull).toHaveBeenCalledTimes(2)
    expect(second).toHaveLength(1)
  })

  it('does not cache rejected pulls', async () => {
    const pull = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue([lspSymbol])
    const proxy = createDocumentSymbolProxy(1, {
      $provideDocumentSymbols: pull,
    } as unknown as IExtHostLanguages)

    const model = makeModel('file:///a.ts')
    await expect(proxy.provideDocumentSymbols(model, null as never)).rejects.toThrow('boom')
    expect(await proxy.provideDocumentSymbols(model, null as never)).toHaveLength(1)
    expect(pull).toHaveBeenCalledTimes(2)
  })
})

describe('createCodeLensProxy pull cache', () => {
  it('serves an unchanged model version from cache and re-pulls after onDidChange', async () => {
    const pull = vi.fn().mockResolvedValue([lspLens])
    const changeEmitter = new Emitter<void>()
    const proxy = createCodeLensProxy(
      1,
      { $provideCodeLenses: pull } as unknown as IExtHostLanguages,
      changeEmitter.event,
      new DisposableStore(),
    )

    const model = makeModel('file:///a.ts')
    await proxy.provideCodeLenses(model, null as never)
    await proxy.provideCodeLenses(model, null as never)
    expect(pull).toHaveBeenCalledTimes(1)

    // Lens data (e.g. reference counts) can change without a document edit —
    // the host signals it via onDidChange and the cache must drop.
    changeEmitter.fire()
    await proxy.provideCodeLenses(model, null as never)
    expect(pull).toHaveBeenCalledTimes(2)
  })
})

const lspEdit = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
  newText: 'x',
}

describe('createDocumentRangeFormattingProxy', () => {
  it('forwards handle/uri/range/options and converts the edits (1-based ranges out)', async () => {
    const pull = vi.fn().mockResolvedValue([lspEdit])
    const proxy = createDocumentRangeFormattingProxy(3, {
      $provideDocumentRangeFormattingEdits: pull,
    } as unknown as IExtHostLanguages)

    const model = makeModel('file:///a.ts')
    const monacoRange = { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 5 }
    const out = await proxy.provideDocumentRangeFormattingEdits(
      model,
      monacoRange as monaco.Range,
      { tabSize: 2, insertSpaces: true } as monaco.languages.FormattingOptions,
      null as never,
    )
    // Monaco 1-based range in → LSP 0-based range on the wire.
    expect(pull).toHaveBeenCalledWith(3, model.uri, rangeToLsp(monacoRange), {
      tabSize: 2,
      insertSpaces: true,
    })
    expect(out).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, text: 'x' },
    ])
  })
})

describe('createOnTypeFormattingProxy', () => {
  it('exposes the trigger characters synchronously and forwards ch/position/options', async () => {
    const pull = vi.fn().mockResolvedValue([lspEdit])
    const proxy = createOnTypeFormattingProxy(
      4,
      { $provideOnTypeFormattingEdits: pull } as unknown as IExtHostLanguages,
      ['}', ';'],
    )
    expect(proxy.autoFormatTriggerCharacters).toEqual(['}', ';'])

    const model = makeModel('file:///a.ts')
    await proxy.provideOnTypeFormattingEdits(
      model,
      { lineNumber: 3, column: 8 } as monaco.Position,
      '}',
      { tabSize: 4, insertSpaces: false } as monaco.languages.FormattingOptions,
      null as never,
    )
    expect(pull).toHaveBeenCalledWith(4, model.uri, { line: 2, character: 7 }, '}', {
      tabSize: 4,
      insertSpaces: false,
    })
  })
})

describe('createInlayHintsProxy', () => {
  it('wires onDidChangeInlayHints to the given event and converts hints', async () => {
    const pull = vi
      .fn()
      .mockResolvedValue([{ position: { line: 1, character: 4 }, label: ': number', kind: 1 }])
    const changeEmitter = new Emitter<void>()
    const proxy = createInlayHintsProxy(
      5,
      { $provideInlayHints: pull } as unknown as IExtHostLanguages,
      changeEmitter.event,
      false,
    )

    let fired = 0
    proxy.onDidChangeInlayHints?.(() => fired++)
    changeEmitter.fire()
    expect(fired).toBe(1)

    const model = makeModel('file:///a.ts')
    const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 6, endColumn: 1 }
    const out = await proxy.provideInlayHints(model, monacoRange as monaco.Range, null as never)
    expect(pull).toHaveBeenCalledWith(5, model.uri, rangeToLsp(monacoRange))
    expect(out?.hints[0]?.position).toEqual({ lineNumber: 2, column: 5 })
    expect(out?.hints[0]?.label).toBe(': number')
  })

  it('omits resolveInlayHint when the provider has no resolve support', () => {
    const proxy = createInlayHintsProxy(
      5,
      { $provideInlayHints: vi.fn() } as unknown as IExtHostLanguages,
      new Emitter<void>().event,
      false,
    )
    expect(proxy.resolveInlayHint).toBeUndefined()
  })

  it('round-trips resolve coordinates to $resolveInlayHint and folds the resolved hint', async () => {
    const pull = vi.fn().mockResolvedValue([
      {
        position: { line: 1, character: 4 },
        label: ': number',
        kind: 1,
        resolveCacheId: 3,
        resolveIndex: 0,
      },
    ])
    const resolve = vi.fn().mockResolvedValue({
      position: { line: 1, character: 4 },
      label: ': number',
      kind: 1,
      tooltip: 'the parameter type',
    })
    const proxy = createInlayHintsProxy(
      5,
      {
        $provideInlayHints: pull,
        $resolveInlayHint: resolve,
      } as unknown as IExtHostLanguages,
      new Emitter<void>().event,
      true,
    )

    const model = makeModel('file:///a.ts')
    const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 6, endColumn: 1 }
    const out = await proxy.provideInlayHints(model, monacoRange as monaco.Range, null as never)
    const hint = out!.hints[0]!
    const resolved = await proxy.resolveInlayHint!(hint, null as never)
    expect(resolve).toHaveBeenCalledWith(5, 3, 0)
    expect(resolved?.tooltip).toBe('the parameter type')
    expect(resolved?.position).toEqual({ lineNumber: 2, column: 5 })
  })

  it('keeps the original hint when the host cache entry is gone or coords are missing', async () => {
    const resolve = vi.fn().mockResolvedValue(null)
    const proxy = createInlayHintsProxy(
      5,
      {
        $provideInlayHints: vi.fn().mockResolvedValue([
          {
            position: { line: 1, character: 4 },
            label: ': number',
            resolveCacheId: 3,
            resolveIndex: 0,
          },
        ]),
        $resolveInlayHint: resolve,
      } as unknown as IExtHostLanguages,
      new Emitter<void>().event,
      true,
    )

    const model = makeModel('file:///a.ts')
    const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 6, endColumn: 1 }
    const out = await proxy.provideInlayHints(model, monacoRange as monaco.Range, null as never)
    const hint = out!.hints[0]!
    expect(await proxy.resolveInlayHint!(hint, null as never)).toBe(hint)

    const bare: monaco.languages.InlayHint = {
      position: { lineNumber: 1, column: 1 },
      label: 'x',
    }
    expect(await proxy.resolveInlayHint!(bare, null as never)).toBe(bare)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
