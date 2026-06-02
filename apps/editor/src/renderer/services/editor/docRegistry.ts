/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  docRegistry — single source of truth for the built-in guide documents shown
 *  in the Welcome page and the Help menu. Markdown content is bundled at build
 *  time via Vite's `?raw` import, so there is no runtime disk read.
 *--------------------------------------------------------------------------------------------*/

import editorGuide from '../../docs/editor-guide.md?raw'
import agentGuide from '../../docs/agent-guide.md?raw'

export type DocId = 'editor-guide' | 'agent-guide'

interface IDocEntry {
  readonly titleKey: string
  readonly titleFallback: string
  readonly content: string
}

export const DOCS: Record<DocId, IDocEntry> = {
  'editor-guide': {
    titleKey: 'welcome.editorGuide',
    titleFallback: 'Editor Guide',
    content: editorGuide,
  },
  'agent-guide': {
    titleKey: 'welcome.agentGuide',
    titleFallback: 'Agent Guide',
    content: agentGuide,
  },
}

export function isDocId(value: unknown): value is DocId {
  return value === 'editor-guide' || value === 'agent-guide'
}
