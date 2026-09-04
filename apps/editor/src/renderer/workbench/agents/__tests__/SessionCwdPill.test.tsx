/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for SessionCwdPill — renders only for a *strict* subdirectory cwd.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Event,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type { IAcpSession } from '../../../services/acp/session/acpSessionModel.js'
import { SessionCwdPill } from '../SessionCwdPill.js'
import { ServicesContext } from '../../useService.js'

const stubUriIdentity: IUriIdentityServiceType = {
  _serviceBrand: undefined,
  platform: 'linux',
  isEqual: (a?: URI, b?: URI) => a?.toString() === b?.toString(),
  isEqualOrParent: () => false,
  getComparisonKey: (uri: URI) => uri.toString(),
  arePathsEqual: (a?: string, b?: string) => a === b,
  getPathComparisonKey: (p: string) => p,
  relativePathUnder: (root: string, child: string) => {
    const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
    const normChild = child.replace(/\\/g, '/')
    if (normChild === normRoot) return ''
    return normChild.startsWith(normRoot + '/') ? normChild.slice(normRoot.length + 1) : null
  },
  createResourceMap: () => new Map() as never,
  createResourceSet: () => new Set() as never,
} as unknown as IUriIdentityServiceType

function makeWorkspace(folder?: URI): IWorkspaceServiceType {
  return {
    _serviceBrand: undefined,
    current: folder ? { folder, name: 'workspace' } : null,
    onDidChangeWorkspace: Event.None,
    recent: [],
    onDidChangeRecent: Event.None,
  } as unknown as IWorkspaceServiceType
}

function renderPill(cwd: string | undefined, folder?: URI) {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, makeWorkspace(folder))
  services.set(IUriIdentityService, stubUriIdentity)
  const inst = new InstantiationService(services)
  const session = { id: 's1', cwd } as unknown as IAcpSession
  return render(
    <ServicesContext.Provider value={inst}>
      <SessionCwdPill session={session} />
    </ServicesContext.Provider>,
  )
}

describe('SessionCwdPill', () => {
  it('renders nothing without a workspace', () => {
    renderPill('X:/workspace/apps', undefined)
    expect(screen.queryByTestId('acp-session-cwd')).toBeNull()
  })

  it('renders nothing when the session cwd is unknown', () => {
    renderPill(undefined, URI.file('X:/workspace'))
    expect(screen.queryByTestId('acp-session-cwd')).toBeNull()
  })

  it('renders nothing for a root-level cwd', () => {
    renderPill('X:/workspace', URI.file('X:/workspace'))
    expect(screen.queryByTestId('acp-session-cwd')).toBeNull()
  })

  it('renders nothing for a cwd outside the workspace', () => {
    renderPill('X:/other', URI.file('X:/workspace'))
    expect(screen.queryByTestId('acp-session-cwd')).toBeNull()
  })

  it('shows the collapsed relative path for a strict subdirectory cwd', () => {
    renderPill('X:/workspace/packages/platform', URI.file('X:/workspace'))
    const pill = screen.getByTestId('acp-session-cwd')
    expect(pill.textContent).toBe('packages/platform')
  })

  it('collapses a deep relative path to head/…/tail', () => {
    renderPill('X:/workspace/a/deep/nested/dir', URI.file('X:/workspace'))
    expect(screen.getByTestId('acp-session-cwd').textContent).toBe('a/…/dir')
  })
})
