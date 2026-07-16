/*---------------------------------------------------------------------------------------------
 *  Tests for WebviewService: custom-editor provider registration, panel open →
 *  host resolve, html/options/message plumbing, and host reset teardown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { IExtHostWebviews } from '@universe-editor/extensions-common'
import { WebviewService } from '../WebviewService.js'

function fakeExtHost(): IExtHostWebviews & {
  resolves: Array<{ providerHandle: number; panelHandle: number; viewType: string }>
  messages: Array<{ panelHandle: number; message: unknown }>
  disposed: number[]
} {
  const resolves: Array<{ providerHandle: number; panelHandle: number; viewType: string }> = []
  const messages: Array<{ panelHandle: number; message: unknown }> = []
  const disposed: number[] = []
  return {
    resolves,
    messages,
    disposed,
    $resolveCustomEditor: (providerHandle, panelHandle, viewType) => {
      resolves.push({ providerHandle, panelHandle, viewType })
      return Promise.resolve()
    },
    $onDidReceiveMessage: (panelHandle, message) => {
      messages.push({ panelHandle, message })
      return Promise.resolve()
    },
    $disposeWebviewPanel: (panelHandle) => {
      disposed.push(panelHandle)
      return Promise.resolve()
    },
  }
}

describe('WebviewService', () => {
  it('registers a provider, opens a panel, and asks the owning host to resolve it', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')

    void mainThread.$registerCustomEditorProvider(7, 'pdf.view')
    expect(svc.hasProviderForViewType('pdf.view')).toBe(true)

    const uri = URI.file('/docs/a.pdf')
    const panel = svc.openPanel('pdf.view', uri)
    expect(panel).toBeTruthy()
    expect(extHost.resolves).toEqual([
      { providerHandle: 7, panelHandle: panel!.panelHandle, viewType: 'pdf.view' },
    ])
  })

  it('returns undefined opening a panel for an unregistered viewType', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    expect(svc.openPanel('missing.view', URI.file('/a.pdf'))).toBeUndefined()
  })

  it('flows html/options from the host into the panel observables', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    void mainThread.$setWebviewOptions(panel.panelHandle, {
      enableScripts: true,
      localResourceRoots: ['/ext/pdf'],
    })
    void mainThread.$setWebviewHtml(panel.panelHandle, '<html>pdf</html>')
    expect(panel.html.get()).toBe('<html>pdf</html>')
    expect(panel.options.get().enableScripts).toBe(true)
    expect(panel.options.get().localResourceRoots).toEqual(['/ext/pdf'])
  })

  it('relays messages both ways', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    const received: unknown[] = []
    panel.onMessageToWebview((m) => received.push(m))
    void mainThread.$postMessageToWebview(panel.panelHandle, { hello: 1 })
    expect(received).toEqual([{ hello: 1 }])

    panel.postMessageFromWebview({ open: 'x' })
    expect(extHost.messages).toEqual([{ panelHandle: panel.panelHandle, message: { open: 'x' } }])
  })

  it('closing a panel notifies the host and drops it', () => {
    const svc = new WebviewService()
    const extHost = fakeExtHost()
    svc.setExtHost('local', extHost)
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    const panel = svc.openPanel('pdf.view', URI.file('/a.pdf'))!

    svc.closePanel(panel.panelHandle)
    expect(extHost.disposed).toEqual([panel.panelHandle])
  })

  it('reset(kind) drops the host’s providers and panels', () => {
    const svc = new WebviewService()
    svc.setExtHost('local', fakeExtHost())
    const mainThread = svc.createMainThread('local')
    void mainThread.$registerCustomEditorProvider(0, 'pdf.view')
    svc.openPanel('pdf.view', URI.file('/a.pdf'))

    svc.reset('local')
    expect(svc.hasProviderForViewType('pdf.view')).toBe(false)
    expect(svc.openPanel('pdf.view', URI.file('/a.pdf'))).toBeUndefined()
  })
})
