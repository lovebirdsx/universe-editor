/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MarkdownView — the shared markdown → React renderer used by both
 *  the ACP chat and the markdown preview editor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type { IEditorResolverService as IEditorResolverServiceType } from '@universe-editor/platform'
import { MarkdownView } from '../MarkdownView.js'
import { ServicesContext } from '../../useService.js'

// Monaco won't load under happy-dom; stub so CodeBlock falls back to plain text.
vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => new Promise(() => {}),
  },
}))

afterEach(() => {
  cleanup()
})

function makeResolver(): IEditorResolverServiceType {
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorResolverServiceType
}

function renderMarkdown(text: string, testId?: string) {
  const services = new ServiceCollection()
  services.set(IEditorResolverService, makeResolver())
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <MarkdownView text={text} {...(testId !== undefined ? { testId } : {})} />
    </ServicesContext.Provider>,
  )
}

describe('MarkdownView', () => {
  it('renders headings, bold, and italic', () => {
    renderMarkdown('# Title\n\nsome **bold** and *em*')
    expect(screen.getByText('Title').tagName).toBe('H1')
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('em').tagName).toBe('EM')
  })

  it('renders ordered and unordered lists', () => {
    renderMarkdown('- a\n- b')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders a code fence with a language attribute', () => {
    const { container } = renderMarkdown('```ts\nconst x = 1\n```')
    const pre = container.querySelector('pre[data-lang="ts"]')
    expect(pre?.textContent).toContain('const x = 1')
  })

  it('renders GFM tables', () => {
    const { container } = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelectorAll('th')).toHaveLength(2)
  })

  it('applies the optional testId to the root', () => {
    renderMarkdown('hello', 'preview-md')
    expect(screen.getByTestId('preview-md')).toBeTruthy()
  })

  it('drops links with unsafe schemes', () => {
    renderMarkdown('[evil](javascript:alert(1))')
    expect(screen.queryByRole('link')).toBeNull()
  })
})
