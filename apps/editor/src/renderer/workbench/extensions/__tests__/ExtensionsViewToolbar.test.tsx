/*---------------------------------------------------------------------------------------------
 *  Tests for the Extensions view title-bar `…` menu: filter tokens written into
 *  the shared search query, the update commands, and the menu's basic keyboard
 *  and dismissal behaviour.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  type ICommandService as ICommandServiceType,
} from '@universe-editor/platform'
import { ExtensionsViewToolbar } from '../ExtensionsViewToolbar.js'
import { extensionsViewState } from '../extensionsViewState.js'
import { EXTENSIONS_HAS_UPDATES_KEY } from '../../../services/extensionsWorkbench/extensionsViewIds.js'
import {
  CheckForExtensionUpdatesAction,
  UpdateAllExtensionsAction,
} from '../../../actions/extensionsActions.js'
import { ServicesContext } from '../../useService.js'

function setup(hasUpdates = false) {
  const executeCommand = vi.fn(async () => undefined)
  const contextKeyService = new ContextKeyService()
  const hasUpdatesKey = contextKeyService.createKey<boolean>(EXTENSIONS_HAS_UPDATES_KEY, hasUpdates)
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as unknown as ICommandServiceType)
  services.set(IContextKeyService, contextKeyService)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ExtensionsViewToolbar />
    </ServicesContext.Provider>,
  )
  return { executeCommand, hasUpdatesKey }
}

const trigger = () => screen.getByTestId('extensions-more-actions')
const menu = () => screen.getByTestId('extensions-more-menu')
const open = () => fireEvent.click(trigger())
const builtinItem = () => screen.getByTestId('extensions-filter-builtin')
const updatesItem = () => screen.getByTestId('extensions-filter-updates')

beforeEach(() => {
  extensionsViewState.reset()
})

afterEach(() => cleanup())

describe('ExtensionsViewToolbar', () => {
  it('opens the menu from the title-bar button and focuses the first item', () => {
    setup()
    expect(screen.queryByTestId('extensions-more-menu')).toBeNull()

    open()

    expect(menu()).toBeTruthy()
    expect(document.activeElement).toBe(builtinItem())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('writes @builtin into the shared query and keeps the menu open', () => {
    setup()
    open()

    fireEvent.click(builtinItem())
    expect(extensionsViewState.query.get()).toBe('@builtin')
    expect(builtinItem().getAttribute('aria-checked')).toBe('true')
    expect(menu()).toBeTruthy()

    fireEvent.click(builtinItem())
    expect(extensionsViewState.query.get()).toBe('')
    expect(builtinItem().getAttribute('aria-checked')).toBe('false')
  })

  it('toggles both filters independently', () => {
    setup()
    open()

    fireEvent.click(updatesItem())
    expect(extensionsViewState.query.get()).toBe('@updates')
    fireEvent.click(builtinItem())
    expect(extensionsViewState.query.get()).toBe('@builtin @updates')
    expect(builtinItem().getAttribute('aria-checked')).toBe('true')
    expect(updatesItem().getAttribute('aria-checked')).toBe('true')
  })

  it('reflects tokens typed into the search box, including the @outdated alias', () => {
    setup()
    act(() => extensionsViewState.setQuery('@OUTDATED'))
    open()

    expect(updatesItem().getAttribute('aria-checked')).toBe('true')
  })

  it('hides Update All until the extensionsHasUpdates key is set', () => {
    const { hasUpdatesKey } = setup(false)
    open()

    expect(screen.queryByTestId('extensions-menu-update-all')).toBeNull()

    act(() => hasUpdatesKey.set(true))
    expect(screen.getByTestId('extensions-menu-update-all')).toBeTruthy()
  })

  it('runs the update commands and closes the menu', () => {
    const { executeCommand } = setup(true)
    open()

    fireEvent.click(screen.getByTestId('extensions-menu-check-for-updates'))
    expect(executeCommand).toHaveBeenCalledWith(CheckForExtensionUpdatesAction.ID)
    expect(screen.queryByTestId('extensions-more-menu')).toBeNull()

    open()
    fireEvent.click(screen.getByTestId('extensions-menu-update-all'))
    expect(executeCommand).toHaveBeenCalledWith(UpdateAllExtensionsAction.ID)
    expect(screen.queryByTestId('extensions-more-menu')).toBeNull()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    setup()
    open()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(screen.queryByTestId('extensions-more-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on an outside mousedown', () => {
    setup()
    open()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByTestId('extensions-more-menu')).toBeNull()
  })

  it('moves the keyboard cursor with ArrowUp/Down and Home/End', () => {
    setup(true)
    open()

    fireEvent.keyDown(builtinItem(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(updatesItem())
    fireEvent.keyDown(updatesItem(), { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId('extensions-menu-update-all'))
    fireEvent.keyDown(screen.getByTestId('extensions-menu-update-all'), { key: 'Home' })
    expect(document.activeElement).toBe(builtinItem())
    fireEvent.keyDown(builtinItem(), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByTestId('extensions-menu-update-all'))
  })
})
