/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IAcpSessionTitleService — never generates a title (returns
 *  undefined), so sessions keep their first-prompt-derived title. Lets
 *  AcpSessionService / AcpSession tests construct sessions without a real AI
 *  model service.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpSessionTitleService } from '../acpSessionTitleService.js'

export class StubSessionTitleService implements IAcpSessionTitleService {
  declare readonly _serviceBrand: undefined
  generateTitle(): Promise<string | undefined> {
    return Promise.resolve(undefined)
  }
}
