/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dedicated preload for same-origin auxiliary editor windows.
 *
 *  This entry deliberately exposes NO IPC bridge, no filesystem helpers, and no Node
 *  surface: the child document is driven entirely by the parent renderer's React portal
 *  through the synchronously returned Window. Keeping a dedicated preload (instead of
 *  inheriting the main one) is part of the security boundary.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge } from 'electron'

// Keep the literal in sync with AUXILIARY_WINDOW_MARKER_KEY in
// shared/ipc/auxiliaryWindowService.ts. This entry must not import the shared contract:
// it would pull the platform bundle into the child preload.
contextBridge.exposeInMainWorld('__universeAuxiliaryWindow', Object.freeze({ marker: true }))
