/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dependency-count guard for AcpSessionService (roadmap 06 · task 1).
 *
 *  The facade regressed once before (14 → 16 injects) while everything else
 *  shrank — the one metric that went the wrong way. This test freezes the
 *  constructor's injected-dependency count so any *increase* fails CI and must
 *  be argued for in review (bump the number here, next to a comment saying why
 *  the new dependency can't live on the registry / coordinator instead).
 *
 *  The target is ≤ 12: as responsibilities move out (title orchestration, auth
 *  cooldown, MCP-dropped alerts), ratchet MAX_INJECTED down toward it. Never up
 *  without a written justification.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { _util } from '@universe-editor/platform'
import { AcpSessionService } from '../acpSessionService.js'

// Current: 16 injected services (was 17; auth-guidance + session-construction
// responsibilities moved to IAcpAuthGuidanceService / IAcpSessionFactory).
// Ratchet DOWN as responsibilities move out (roadmap 06 · task 1 target ≤ 12).
// Raising this requires a review note here explaining why the dependency can't
// be reached via _registry / _coordinator / a collaborator service.
//
// +1 IFileService (session-scoped MCP selection): resolving the wire MCP list
// reads the project-level `.mcp.json` from the workspace root — that file
// lives on the workspace filesystem, not in configuration, so no existing
// collaborator (config / registry / coordinator) can reach it.
//
// +1 IExtensionMcpServersService (declarative `contributes.mcpServers`):
// extension-contributed MCP servers are a RUNTIME source — they are never
// written to any settings layer, so IConfigurationService cannot surface them,
// and no other collaborator owns the scanned-extension record. The facade
// needs the record (merge layer) + whenReady (cold-start barrier) +
// onDidChange (pool refresh).
//
// +1 IMcpServerEnablementService (storage-backed MCP default on/off): the
// default enable switch moved out of `acp.mcpServers` entries into
// IStorageService (GLOBAL + WORKSPACE scopes). It is a distinct storage domain
// with its own cold-start barrier and change event — no existing collaborator
// (config reads settings layers, extension service owns the manifest record)
// can answer isEnabled/whenReady/onDidChange for it. The facade needs all
// three to annotate the definition pool and keep it fresh; writes go straight
// to IMcpServerEnablementService from the UI (no facade method).
// +1 IWindowsService (OOM crash-loop guard): the "skip auto-resume after a
// recent OOM crash" decision needs this window's last render-process-gone
// record, which lives in the main process behind IWindowsService
// (getLastRenderCrash). The facade injects it only to hand the query to the
// restore coordinator's shouldSkipAutoResume callback — the coordinator
// itself is constructed with plain callbacks and stays IPC-free, so the
// dependency cannot move there without leaking the proxy into its tests.
const MAX_INJECTED = 19

describe('AcpSessionService dependency budget', () => {
  it('does not exceed the injected-dependency ceiling', () => {
    const deps = _util.getServiceDependencies(AcpSessionService)
    expect(deps.length).toBeLessThanOrEqual(MAX_INJECTED)
  })
})
