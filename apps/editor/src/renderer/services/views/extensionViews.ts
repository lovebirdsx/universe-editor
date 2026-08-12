/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared key for extension-contributed tree views. Every `contributes.views`
 *  entry registers its descriptor with this componentKey (the static manifest
 *  phase cannot know a per-extension component); the single component bound to
 *  it receives its own view id via props and dispatches data per view (the tree
 *  data provider wiring is a later phase).
 *--------------------------------------------------------------------------------------------*/

export const EXTENSION_TREE_VIEW_COMPONENT_KEY = 'extension.treeView'
