/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire-boundary pull cache regression tests. Symbol/lens responses for a large
 *  file are multi-MB frames — re-attaching a model (tab switch) must not re-pull
 *  them for an unchanged model version, regardless of which Monaco consumer asks.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { DisposableStore, Emitter } from '@universe-editor/platform'
import type { IExtHostLanguages } from '@universe-editor/extensions-common'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { createCodeLensProxy, createDocumentSymbolProxy } from '../languageProviderProxy.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { get: () => ({}), peek: () => undefined },
}))

function makeModel(uri: string, versionId = 1): monaco.editor.ITextModel {
  return {
    uri: { toString: () => uri },
    getVersionId: () => versionId,
  } as unknown as monaco.editor.ITextModel
}

const lspSymbol = {
  name: 'A',
  kind: 5,
  range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
  selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
}

const lspLens = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }

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
