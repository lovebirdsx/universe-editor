/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useOpenTerminalFile — terminal file-path links must open through IOpenerService
 *  (with the line/column encoded as a selection fragment), not a hand-rolled
 *  FileEditorInput + setTimeout dance.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  InstantiationService,
  IOpenerService,
  ServiceCollection,
  URI,
  withSelection,
} from '@universe-editor/platform'
import { ServicesContext } from '../../../useService.js'
import { useOpenTerminalFile } from '../useTerminalOpenFile.js'

function makeOpener(): { opener: IOpenerService; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn().mockResolvedValue(true)
  const opener = {
    _serviceBrand: undefined,
    registerOpener: () => ({ dispose() {} }),
    open,
  } as unknown as IOpenerService
  return { opener, open }
}

function setup(opener: IOpenerService) {
  const services = new ServiceCollection()
  services.set(IOpenerService, opener)
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useOpenTerminalFile(), { wrapper })
}

describe('useOpenTerminalFile', () => {
  afterEach(() => cleanup())

  it('opens a plain URI through IOpenerService', () => {
    const { opener, open } = makeOpener()
    const { result } = setup(opener)
    const uri = URI.file('/repo/src/foo.ts')

    result.current(uri)

    expect(open).toHaveBeenCalledWith(uri, { fromUserGesture: true })
  })

  it('encodes line/column into a selection fragment', () => {
    const { opener, open } = makeOpener()
    const { result } = setup(opener)
    const uri = URI.file('/repo/src/foo.ts')

    result.current(uri, 10, 5)

    expect(open).toHaveBeenCalledWith(withSelection(uri, { startLineNumber: 10, startColumn: 5 }), {
      fromUserGesture: true,
    })
  })

  it('defaults column to 1 when only a line is given', () => {
    const { opener, open } = makeOpener()
    const { result } = setup(opener)
    const uri = URI.file('/repo/src/foo.ts')

    result.current(uri, 10)

    expect(open).toHaveBeenCalledWith(withSelection(uri, { startLineNumber: 10, startColumn: 1 }), {
      fromUserGesture: true,
    })
  })
})
