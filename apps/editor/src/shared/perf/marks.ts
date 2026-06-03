/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Canonical performance-mark names shared by both processes. Main and renderer
 *  emit these via @universe-editor/platform's `mark()`; the renderer's TimerService
 *  reads them back to build the startup timeline. Add new milestones here so the
 *  name stays in lock-step between the emit site and the reader.
 *--------------------------------------------------------------------------------------------*/

export const PerfMarks = {
  /** Injected automatically by the perf util as the first mark in each process. */
  timeOrigin: 'code/timeOrigin',

  mainDidStart: 'code/main/didStart',
  mainAppReady: 'code/main/appReady',
  mainDidCreateServices: 'code/main/didCreateServices',
  mainWillCreateWindow: 'code/main/willCreateWindow',
  mainDidShowWindow: 'code/main/didShowWindow',

  rendererWillStartBootstrap: 'code/renderer/willStartBootstrap',
  rendererDidCreateIpc: 'code/renderer/didCreateIpc',
  rendererWillRestore: 'code/renderer/willRestore',
  rendererDidRestoreServices: 'code/renderer/didRestoreServices',
  rendererDidMount: 'code/renderer/didMount',
  rendererDidRestoreEditors: 'code/renderer/didRestoreEditors',
} as const
