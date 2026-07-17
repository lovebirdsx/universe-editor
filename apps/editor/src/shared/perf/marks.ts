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

  /**
   * Main: OS process creation time (from `process.getCreationTime()`), stamped as
   * the earliest mark so the pre-JS gap — process spawn → first main-process line
   * executing — becomes measurable. This window is where antivirus first-scans the
   * freshly written exe/asar, the dominant cost of the slow post-update first launch.
   */
  mainProcessCreated: 'code/main/processCreated',
  mainDidStart: 'code/main/didStart',
  mainAppReady: 'code/main/appReady',
  mainDidCreateServices: 'code/main/didCreateServices',
  mainWillCreateWindow: 'code/main/willCreateWindow',
  mainDidShowWindow: 'code/main/didShowWindow',

  /** Main: first extension-host child process spawned (lazy, may fire after window shown). */
  extHostDidSpawn: 'code/main/extHostDidSpawn',

  /** Main: parcel recursive watch() on the workspace root started / resolved. */
  mainWillWatchWorkspace: 'code/main/willWatchWorkspace',
  mainDidWatchWorkspace: 'code/main/didWatchWorkspace',

  rendererWillStartBootstrap: 'code/renderer/willStartBootstrap',
  rendererDidCreateIpc: 'code/renderer/didCreateIpc',
  rendererWillRestore: 'code/renderer/willRestore',

  /**
   * Renderer: BlockRestore contributions finished (synchronous part of
   * setPhase(Ready), incl. WorkspaceRestoreContribution rebuilding editor
   * groups). willRestore → here isolates the contribution cost.
   */
  rendererDidBlockRestore: 'code/renderer/didBlockRestore',
  /** Renderer: about to await the parallel state-restore load() group. */
  rendererWillLoadServices: 'code/renderer/willLoadServices',
  /**
   * Renderer: per-service completion of the parallel restore group. These run
   * concurrently, so compare each one's offset (not adjacent-milestone deltas)
   * to find which restore dominates on a heavy workspace.
   */
  rendererDidLoadLayout: 'code/renderer/didLoadLayout',
  rendererDidLoadViewDescriptor: 'code/renderer/didLoadViewDescriptor',
  rendererDidLoadViews: 'code/renderer/didLoadViews',
  rendererDidLoadTerminals: 'code/renderer/didLoadTerminals',

  rendererDidRestoreServices: 'code/renderer/didRestoreServices',
  /** Renderer: about to createRoot()/render the Workbench React tree. */
  rendererWillMountReact: 'code/renderer/willMountReact',
  rendererDidMount: 'code/renderer/didMount',
  /**
   * Renderer: the post-mount WORKSPACE-state reconcile (layout / views /
   * viewDescriptor / terminal) finished. Fires after didMount because the
   * reconcile is no longer a first-paint barrier — it waits for the main-side
   * workspace hydration off the critical path and applies via observables.
   */
  rendererDidReconcileWorkspaceState: 'code/renderer/didReconcileWorkspaceState',
  rendererDidRestoreEditors: 'code/renderer/didRestoreEditors',
  /** Renderer: monaco-editor finished lazy initialization (lazy, may fire after mount). */
  rendererDidInitializeMonaco: 'code/renderer/didInitializeMonaco',
} as const
