/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ICommandService,
  IStatusBarService,
  InstantiationService,
  ServiceCollection,
  StatusBarAlignment,
  constObservable,
  type IStatusBarEntry,
  type IStoredStatusBarEntry,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { StatusBar } from '../StatusBar.js'

function storedEntry(id: number, entry: IStatusBarEntry): IStoredStatusBarEntry {
  return { id, entry }
}

function makeContainer(entries: readonly IStoredStatusBarEntry[]): InstantiationService {
  const sc = new ServiceCollection()
  sc.set(IStatusBarService, {
    _serviceBrand: undefined,
    addEntry: () => ({ update: () => {}, dispose: () => {} }),
    entries: constObservable(entries),
  } as unknown as IStatusBarService)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  } as unknown as ICommandService)
  return new InstantiationService(sc)
}

function renderStatusBar(entries: readonly IStoredStatusBarEntry[]): void {
  render(
    <ServicesContext.Provider value={makeContainer(entries)}>
      <StatusBar />
    </ServicesContext.Provider>,
  )
}

describe('StatusBar — entry visuals', () => {
  it('exposes a stable data-testid for entries with a semantic id', () => {
    renderStatusBar([
      storedEntry(1, {
        id: 'remote',
        text: 'WSL: Ubuntu',
        alignment: StatusBarAlignment.Left,
        priority: 0,
      }),
    ])
    const button = screen.getByTestId('statusbar-entry-remote')
    expect(button.textContent).toContain('WSL: Ubuntu')
  })

  it('renders no data-testid for entries without a semantic id', () => {
    renderStatusBar([
      storedEntry(1, { text: 'plain', alignment: StatusBarAlignment.Right, priority: 0 }),
    ])
    const button = screen.getByRole('button')
    expect(button.hasAttribute('data-testid')).toBe(false)
  })

  it('renders theme color vars as inline background/color for colored entries', () => {
    renderStatusBar([
      storedEntry(1, {
        id: 'remote',
        text: 'WSL: Ubuntu',
        alignment: StatusBarAlignment.Left,
        priority: 0,
        backgroundColor: 'statusBarItem.remoteBackground',
        color: 'statusBarItem.remoteForeground',
      }),
    ])
    const button = screen.getByTestId('statusbar-entry-remote')
    expect(button.style.background).toBe('var(--vscode-statusBarItem-remoteBackground)')
    expect(button.style.color).toBe('var(--vscode-statusBarItem-remoteForeground)')
    expect(button.className).toContain('has-background')
  })

  it('renders only the provided color slots (background without foreground)', () => {
    renderStatusBar([
      storedEntry(1, {
        id: 'error',
        text: 'Error',
        alignment: StatusBarAlignment.Right,
        priority: 0,
        backgroundColor: 'statusBarItem.errorBackground',
      }),
    ])
    const button = screen.getByTestId('statusbar-entry-error')
    expect(button.style.background).toBe('var(--vscode-statusBarItem-errorBackground)')
    expect(button.style.color).toBe('')
    expect(button.className).toContain('has-background')
  })

  it('renders no inline style for entries without colors', () => {
    renderStatusBar([
      storedEntry(1, {
        id: 'plain',
        text: 'plain',
        alignment: StatusBarAlignment.Left,
        priority: 0,
      }),
    ])
    const button = screen.getByTestId('statusbar-entry-plain')
    expect(button.getAttribute('style')).toBeNull()
    expect(button.className).not.toContain('has-background')
  })
})
