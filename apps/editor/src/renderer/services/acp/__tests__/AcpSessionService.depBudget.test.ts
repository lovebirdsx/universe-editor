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

// Current: 15 injected services (was 17; auth-guidance + session-construction
// responsibilities moved to IAcpAuthGuidanceService / IAcpSessionFactory).
// Ratchet DOWN as responsibilities move out (roadmap 06 · task 1 target ≤ 12).
// Raising this requires a review note here explaining why the dependency can't
// be reached via _registry / _coordinator / a collaborator service.
const MAX_INJECTED = 15

describe('AcpSessionService dependency budget', () => {
  it('does not exceed the injected-dependency ceiling', () => {
    const deps = _util.getServiceDependencies(AcpSessionService)
    expect(deps.length).toBeLessThanOrEqual(MAX_INJECTED)
  })
})
