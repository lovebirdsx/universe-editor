/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Display title lookup for Vim's discovery UIs: registry description, else humanized id.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { CommandsRegistry, type IDisposable } from '@universe-editor/platform'
import { humanizeCommandId, resolveVimCommandTitle } from '../vimCommandTitle.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function register(id: string, description?: string): void {
  disposables.push(
    CommandsRegistry.registerCommand({
      id,
      handler: () => undefined,
      ...(description === undefined ? {} : { metadata: { description } }),
    }),
  )
}

describe('humanizeCommandId', () => {
  it.each([
    ['editor.action.goToReferences', 'Go To References'],
    ['workbench.action.focusSideBar', 'Focus Side Bar'],
    ['list.focusDown', 'Focus Down'],
    ['surface.next', 'Next'],
    ['some-kebab_and_snake', 'Some kebab and snake'],
    ['single', 'Single'],
    ['', ''],
  ])('%j -> %j', (id, expected) => {
    expect(humanizeCommandId(id)).toBe(expected)
  })
})

describe('resolveVimCommandTitle', () => {
  it('prefers the registered description', () => {
    register('test.vimTitle.described', 'Do The Thing')
    expect(resolveVimCommandTitle('test.vimTitle.described')).toBe('Do The Thing')
  })

  it('falls back to the humanized id when the command is unknown', () => {
    expect(resolveVimCommandTitle('editor.action.notRegisteredAnywhere')).toBe(
      'Not Registered Anywhere',
    )
  })

  it('falls back when the description is missing or empty', () => {
    register('test.vimTitle.noMeta')
    register('test.vimTitle.emptyMeta', '')
    expect(resolveVimCommandTitle('test.vimTitle.noMeta')).toBe('No Meta')
    expect(resolveVimCommandTitle('test.vimTitle.emptyMeta')).toBe('Empty Meta')
  })
})
