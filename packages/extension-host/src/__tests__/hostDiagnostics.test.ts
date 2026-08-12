/*---------------------------------------------------------------------------------------------
 *  HostDiagnostics: getDiagnostics forwards to the renderer uncached; the
 *  change event ref-counts renderer interest — the first listener subscribes
 *  marker pushes, the last dispose unsubscribes.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest'
import type { IMainThreadLanguages } from '@universe-editor/extensions-common'
import type { UriComponents } from '@universe-editor/extension-api'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { DiagnosticChangeEventBridge } from '../apiFactory.js'
import { HostDiagnostics } from '../hostDiagnostics.js'

function fakeMainThread(): IMainThreadLanguages & {
  subscribeCount: () => number
  unsubscribeCount: () => number
  getDiagnosticsCalls: () => ReadonlyArray<UriComponents | undefined>
} {
  let subscribeCount = 0
  let unsubscribeCount = 0
  const getDiagnosticsCalls: Array<UriComponents | undefined> = []
  const state = {
    subscribeCount: () => subscribeCount,
    unsubscribeCount: () => unsubscribeCount,
    getDiagnosticsCalls: () => getDiagnosticsCalls,
    $getDiagnostics: (uri?: UriComponents) => {
      getDiagnosticsCalls.push(uri)
      return Promise.resolve<Array<[UriComponents, Diagnostic[]]>>([])
    },
    $subscribeDiagnostics: () => {
      subscribeCount++
      return Promise.resolve()
    },
    $unsubscribeDiagnostics: () => {
      unsubscribeCount++
      return Promise.resolve()
    },
  }
  return state as unknown as IMainThreadLanguages & {
    subscribeCount: () => number
    unsubscribeCount: () => number
    getDiagnosticsCalls: () => ReadonlyArray<UriComponents | undefined>
  }
}

const uriA = { scheme: 'file', path: '/test/a.ts' } as UriComponents

describe('HostDiagnostics', () => {
  it('getDiagnostics forwards to the renderer, with and without a uri', async () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)

    await host.getDiagnostics()
    await host.getDiagnostics(uriA)
    expect(mt.getDiagnosticsCalls()).toEqual([undefined, uriA])
  })

  it('the first listener subscribes renderer pushes; further listeners do not', () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)

    const sub1 = host.onDidChangeDiagnostics(() => {})
    expect(mt.subscribeCount()).toBe(1)
    const sub2 = host.onDidChangeDiagnostics(() => {})
    expect(mt.subscribeCount()).toBe(1)

    sub1.dispose()
    sub2.dispose()
  })

  it('unsubscribes only after the last listener disposes', () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)

    const sub1 = host.onDidChangeDiagnostics(() => {})
    const sub2 = host.onDidChangeDiagnostics(() => {})
    sub1.dispose()
    expect(mt.unsubscribeCount()).toBe(0)
    sub2.dispose()
    expect(mt.unsubscribeCount()).toBe(1)
  })

  it('a double dispose flips interest only once', () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)

    const sub = host.onDidChangeDiagnostics(() => {})
    sub.dispose()
    sub.dispose()
    expect(mt.subscribeCount()).toBe(1)
    expect(mt.unsubscribeCount()).toBe(1)
  })

  it('acceptDiagnosticsChange fires only while listeners are alive', () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)
    const seen: DiagnosticChangeEventBridge[] = []

    host.acceptDiagnosticsChange([uriA])

    const sub = host.onDidChangeDiagnostics((e) => seen.push(e))
    host.acceptDiagnosticsChange([uriA])
    expect(seen).toEqual([{ uris: [uriA] }])

    sub.dispose()
    host.acceptDiagnosticsChange([uriA])
    expect(seen).toHaveLength(1)
  })

  it('dispose() releases renderer interest when listeners are still alive', () => {
    const mt = fakeMainThread()
    const host = new HostDiagnostics(mt)

    host.onDidChangeDiagnostics(() => {})
    host.onDidChangeDiagnostics(() => {})
    expect(mt.subscribeCount()).toBe(1)

    host.dispose()
    expect(mt.unsubscribeCount()).toBe(1)
  })
})
