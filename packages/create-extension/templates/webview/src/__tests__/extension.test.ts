import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext, UriComponents, WebviewPanel } from '@universe-editor/extension-api'
import { activate } from '../extension.js'
import { PreviewDocument } from '../preview.js'

const mocks = vi.hoisted(() => ({
  registerCustomEditorProvider: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  window: { registerCustomEditorProvider: mocks.registerCustomEditorProvider },
}))

const URI: UriComponents = { scheme: 'file', path: '/tmp/sample.__name__' }

type PreviewProvider = {
  openCustomDocument: (uri: UriComponents) => PreviewDocument
  resolveCustomEditor: (document: PreviewDocument, panel: WebviewPanel) => void
}

let provider: PreviewProvider | undefined

function fakeContext(): ExtensionContext {
  return { extensionPath: '/ext', subscriptions: { push: vi.fn() } } as unknown as ExtensionContext
}

function fakePanel(): WebviewPanel {
  return { webview: { options: {}, html: '' } } as unknown as WebviewPanel
}

beforeEach(() => {
  vi.clearAllMocks()
  provider = undefined
  mocks.registerCustomEditorProvider.mockImplementation(
    (_type: string, p: PreviewProvider) => {
      provider = p
      return { dispose: () => undefined }
    },
  )
})

describe('activate', () => {
  it('registers the preview provider for *.__name__ files', () => {
    activate(fakeContext())
    expect(mocks.registerCustomEditorProvider).toHaveBeenCalledWith(
      '__name__.preview',
      expect.any(Object),
      { supportsMultipleEditorsPerDocument: false },
    )
  })

  it('opens a PreviewDocument carrying the uri', () => {
    activate(fakeContext())
    const document = provider?.openCustomDocument(URI)
    expect(document).toBeInstanceOf(PreviewDocument)
    expect(document?.uri).toEqual(URI)
  })

  it('resolves the custom editor with rendered html and localResourceRoots', () => {
    activate(fakeContext())
    const panel = fakePanel()
    provider?.resolveCustomEditor(new PreviewDocument(URI), panel)

    expect(panel.webview.html).toContain('__displayName__')
    expect(panel.webview.html).toContain('sample.__name__')
    expect(panel.webview.options).toEqual({
      enableScripts: false,
      localResourceRoots: [
        { scheme: 'file', path: '/ext' },
        { scheme: 'file', path: '/tmp' },
      ],
    })
  })
})
