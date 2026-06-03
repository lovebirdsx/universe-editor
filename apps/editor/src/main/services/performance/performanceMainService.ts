/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Exposes the main process's performance marks over IPC.
 *--------------------------------------------------------------------------------------------*/

import { getMarks, type PerformanceMark } from '@universe-editor/platform'
import type { IPerformanceMarksService } from '../../../shared/ipc/services.js'

export class PerformanceMainService implements IPerformanceMarksService {
  declare readonly _serviceBrand: undefined

  getMarks(): Promise<PerformanceMark[]> {
    return Promise.resolve(getMarks())
  }
}
