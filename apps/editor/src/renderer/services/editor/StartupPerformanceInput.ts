/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StartupPerformanceInput — a stateless virtual EditorInput. The editor renders
 *  live data from ITimerService on mount, so the input carries no payload and a
 *  fixed resource makes it a singleton tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export class StartupPerformanceInput extends EditorInput {
  static readonly TYPE_ID = 'startupPerformance'

  override get typeId(): string {
    return StartupPerformanceInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'startup-performance', path: '/' })
  }

  override get id(): string {
    return 'startup-performance'
  }

  override getName(): string {
    return 'Startup Performance'
  }

  override serialize(): Record<string, never> {
    return {}
  }

  static deserialize(): StartupPerformanceInput {
    return new StartupPerformanceInput()
  }
}
