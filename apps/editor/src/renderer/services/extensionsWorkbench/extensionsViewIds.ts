/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  View / ViewContainer ids for the Extensions workbench. Kept apart from the
 *  contribution so the badge, the actions and the view share one literal, and so
 *  node-side tests can import the ids without pulling in a .tsx + CSS graph.
 *--------------------------------------------------------------------------------------------*/

/** Activity Bar container (the badge target). */
export const EXTENSIONS_VIEW_CONTAINER_ID = 'workbench.view.extensions'

/** The single view inside it. */
export const EXTENSIONS_VIEW_ID = 'workbench.view.extensions.main'

/** Context key: at least one installed, enabled extension has a pending update. */
export const EXTENSIONS_HAS_UPDATES_KEY = 'extensionsHasUpdates'
