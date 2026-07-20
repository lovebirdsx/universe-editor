/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared layout size constraints, consumed by both the Allotment layout panes
 *  (WorkbenchLayout) and the keyboard resize commands (layoutActions).
 *--------------------------------------------------------------------------------------------*/

export const SIDEBAR_MIN = 170
export const SIDEBAR_MAX = 1000 // secondarySidebar shares this range
export const PANEL_MIN = 100
export const PANEL_MAX = 800

// VSCode's DEFAULT_EDITOR_MIN_DIMENSIONS.width. Keeps the editor area from
// being squeezed away when a sidebar approaches SIDEBAR_MAX.
export const EDITOR_MIN = 220

/** Pixels added/removed per keyboard resize step. */
export const RESIZE_STEP = 50
