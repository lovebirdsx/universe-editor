/*---------------------------------------------------------------------------------------------
 *  Regression for the "mermaid goes blank after tab switch / under StrictMode" bug.
 *  dev (pnpm dev) wraps the app in <StrictMode>, which double-invokes effects:
 *  mount → run effect → cleanup → run effect again. MermaidBlock's effect calls
 *  MermaidLoader.render(...) twice for the same diagram. The fix moves render-id
 *  generation + serialization into MermaidLoader, so MermaidBlock no longer hands
 *  a shared id down — and the surviving render is whichever resolves last, never an
 *  empty diagram from two renders deleting each other's measurement nodes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type { IConfigurationService as IConfigurationServiceType } from '@universe-editor/platform'
import { MermaidBlock } from '../MermaidBlock.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }))
vi.mock('../mermaidLoader.js', () => ({
  MermaidLoader: {
    ensureInitialized: () => Promise.resolve({}),
    render: renderMock,
  },
}))

afterEach(() => {
  cleanup()
  renderMock.mockReset()
})

function renderBlock(code: string) {
  const services = new ServiceCollection()
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: () => 'dark',
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as unknown as IConfigurationServiceType)
  const inst = new InstantiationService(services)
  return render(
    <StrictMode>
      <ServicesContext.Provider value={inst}>
        <MermaidBlock code={code} />
      </ServicesContext.Provider>
    </StrictMode>,
  )
}

describe('MermaidBlock under StrictMode', () => {
  it('calls the loader with (code, theme) only — render id is owned by the loader', async () => {
    renderMock.mockResolvedValue('<svg id="ok"><g/></svg>')
    renderBlock('pie\n "A" : 1')
    await waitFor(() => expect(renderMock).toHaveBeenCalled())
    for (const call of renderMock.mock.calls) {
      expect(call).toEqual(['pie\n "A" : 1', 'dark'])
    }
  })

  it('shows the last-resolved svg even when the effect double-invokes', async () => {
    // Two renders for the same block (StrictMode). The fix relies on the loader
    // serializing so the surviving setSvg is a complete diagram, not an empty one.
    let n = 0
    renderMock.mockImplementation(() => Promise.resolve(`<svg id="r${n++}"><path d="M0 0"/></svg>`))
    const { findByTestId } = renderBlock('pie\n "A" : 1')
    const diagram = await findByTestId('mermaid-diagram')
    expect(diagram.querySelector('path')).toBeTruthy()
  })
})
