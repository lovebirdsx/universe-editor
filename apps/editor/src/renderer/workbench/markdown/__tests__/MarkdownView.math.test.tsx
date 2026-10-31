/*---------------------------------------------------------------------------------------------
 *  MarkdownView integration tests for math rendering. The lazy KaTeX loader is
 *  stubbed with a synchronous fake so these tests exercise dispatch, placement
 *  and configuration, not KaTeX itself (see mathRenderer.test.ts).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
  type IConfigurationChangeEvent,
} from '@universe-editor/platform'
import { MarkdownView } from '../MarkdownView.js'
import { ServicesContext } from '../../useService.js'

// Monaco won't load under happy-dom; stub so CodeBlock falls back synchronously.
vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => new Promise(() => {}),
  },
}))

// `loaded` is read synchronously on mount; tests that want the loading path set
// it to undefined and let `ensureInitialized` resolve.
const { renderMathMock, loaderState } = vi.hoisted(() => {
  const renderMathMock = vi.fn()
  return { renderMathMock, loaderState: { loaded: renderMathMock as unknown } }
})
vi.mock('../mathLoader.js', () => ({
  MathLoader: {
    getLoaded: () => loaderState.loaded,
    ensureInitialized: () => Promise.resolve(renderMathMock),
  },
}))

beforeEach(() => {
  loaderState.loaded = renderMathMock
  renderMathMock.mockImplementation(
    (tex: string, display: boolean) =>
      `<span class="katex-stub" data-display="${String(display)}">${tex}</span>`,
  )
})

afterEach(() => {
  cleanup()
  renderMathMock.mockReset()
})

describe('MarkdownView — math', () => {
  it('renders a block formula with its source line', () => {
    render(<MarkdownView text={'$$\nx^2\n$$'} />)
    const block = screen.getByTestId('md-math-block')
    expect(block.getAttribute('data-line')).toBe('0')
    expect(block.querySelector('.katex-stub')?.getAttribute('data-display')).toBe('true')
    expect(renderMathMock).toHaveBeenCalledWith('x^2', true, expect.anything())
  })

  it('keeps inline math an inline element inside the paragraph', () => {
    const { container } = render(<MarkdownView text={'a $x$ b'} />)
    const inline = screen.getByTestId('md-math-inline')
    expect(inline.tagName).toBe('SPAN')
    expect(inline.closest('p')).not.toBeNull()
    expect(container.querySelector('p div')).toBeNull()
    expect(container.querySelector('p > div')).toBeNull()
    expect(inline.querySelector('.katex-stub')?.getAttribute('data-display')).toBe('false')
  })

  it('marks mid-paragraph $$…$$ as display mode without emitting a div', () => {
    const { container } = render(<MarkdownView text={'a $$x$$ b'} />)
    const inline = screen.getByTestId('md-math-inline')
    expect(inline.getAttribute('data-math-display')).toBe('true')
    expect(container.querySelector('p div')).toBeNull()
    expect(renderMathMock).toHaveBeenCalledWith('x', true, expect.anything())
  })

  it('renders a ```math fence through the block node', () => {
    render(<MarkdownView text={'before\n\n```math\nx^2\n```'} />)
    const block = screen.getByTestId('md-math-block')
    expect(block.getAttribute('data-line')).toBe('2')
    expect(renderMathMock).toHaveBeenCalledWith('x^2', true, expect.anything())
  })

  it('renders math by default for consumers that pass no math prop', () => {
    render(<MarkdownView text={'$\alpha$'} />)
    expect(screen.getByTestId('md-math-inline')).toBeTruthy()
  })

  it('falls back to plain TeX when math is disabled', () => {
    const { container } = render(<MarkdownView text={'$$\nx^2\n$$'} math={false} />)
    expect(screen.queryByTestId('md-math-block')).toBeNull()
    expect(container.textContent).toContain('x^2')
    expect(renderMathMock).not.toHaveBeenCalled()
  })

  it('leaves a ```math fence as a code block when math is disabled', () => {
    render(<MarkdownView text={'```math\nx^2\n```'} math={false} />)
    expect(screen.queryByTestId('md-math-block')).toBeNull()
    expect(renderMathMock).not.toHaveBeenCalled()
  })

  it('forwards user macros to the renderer', () => {
    const macros = Object.freeze({ [String.raw`\RR`]: String.raw`\mathbb{R}` })
    render(<MarkdownView text={String.raw`$\RR$`} mathMacros={macros} />)
    expect(renderMathMock).toHaveBeenCalledWith(String.raw`\RR`, false, macros)
  })

  it('reads markdown.math.macros from configuration and reacts to changes', async () => {
    const emitter = new Emitter<IConfigurationChangeEvent>()
    let macros: Record<string, string> = { [String.raw`\RR`]: String.raw`\mathbb{R}` }
    const config = {
      _serviceBrand: undefined,
      get: (key: string) => (key === 'markdown.math.macros' ? macros : undefined),
      onDidChangeConfiguration: emitter.event,
    }
    const services = new ServiceCollection()
    services.set(IConfigurationService, config as unknown as IConfigurationService)
    const inst = new InstantiationService(services)
    try {
      render(
        <ServicesContext.Provider value={inst}>
          <MarkdownView text={String.raw`$\RR$`} />
        </ServicesContext.Provider>,
      )
      expect(renderMathMock).toHaveBeenCalledWith(String.raw`\RR`, false, macros)

      macros = { [String.raw`\RR`]: String.raw`\mathbf{R}` }
      act(() => {
        emitter.fire({
          keys: ['markdown.math.macros'],
          affectsConfiguration: (key: string): boolean => key === 'markdown.math.macros',
        })
      })
      await waitFor(() =>
        expect(renderMathMock).toHaveBeenLastCalledWith(String.raw`\RR`, false, macros),
      )
    } finally {
      emitter.dispose()
    }
  })

  it('shows the raw TeX when the renderer fails', () => {
    renderMathMock.mockReturnValue('')
    render(<MarkdownView text={'$bad$'} />)
    expect(screen.getByTestId('md-math-inline').textContent).toBe('bad')
  })

  it('shows the raw TeX until the lazy renderer finishes loading', async () => {
    loaderState.loaded = undefined
    render(<MarkdownView text={'$x$'} />)
    const inline = screen.getByTestId('md-math-inline')
    expect(inline.textContent).toBe('x')
    await waitFor(() => expect(inline.querySelector('.katex-stub')).not.toBeNull())
  })

  it('renders math in the streaming tail with absolute line numbers', () => {
    const { rerender } = render(<MarkdownView text={'intro\n\n$$\nx\n$$'} streaming />)
    expect(screen.getByTestId('md-math-block').getAttribute('data-line')).toBe('2')
    rerender(<MarkdownView text={'intro\n\n$$\nx\n$$\n\ntail'} streaming />)
    expect(screen.getByTestId('md-math-block').getAttribute('data-line')).toBe('2')
    expect(screen.getByText('tail')).toBeTruthy()
  })

  it('re-parses a sealed prefix when math is toggled off', () => {
    // The blank after the formula seals it into the incremental cache; without
    // the option-keyed cache reset the stale math nodes would survive the toggle.
    const text = '$$\nx\n$$\n\nintro'
    const { rerender } = render(<MarkdownView text={text} streaming />)
    expect(screen.getByTestId('md-math-block')).toBeTruthy()
    renderMathMock.mockClear()
    rerender(<MarkdownView text={text} streaming math={false} />)
    expect(screen.queryByTestId('md-math-block')).toBeNull()
    expect(renderMathMock).not.toHaveBeenCalled()
  })
})
