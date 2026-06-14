/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Bridges the configuration service to Monaco editor options. Every registered
 *  `editor.*` setting is read from config and assembled into the nested shape
 *  Monaco's `updateOptions` expects, e.g. `editor.minimap.autohide` ->
 *  `{ minimap: { autohide } }`. Monaco silently ignores option keys it does not
 *  recognise, so passing the full set is safe.
 *
 *  A handful of settings have bespoke handling in FileEditor/DiffEditor
 *  (language-aware fonts, theme-derived colors) and are excluded here so the
 *  bridge never fights that logic. Plain pass-through options (wordWrap, tabSize,
 *  insertSpaces, detectIndentation, …) now share Monaco's exact value shape, so
 *  the bridge forwards them directly.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  type IConfigurationService,
  type IConfigurationChangeEvent,
} from '@universe-editor/platform'
import type { monaco } from './MonacoLoader.js'

// Keys owned by FileEditor/DiffEditor directly. The bridge skips these.
const BESPOKE_KEYS = new Set<string>([
  'editor.fontSize',
  'editor.fontFamily',
  'editor.fontWeight',
  'editor.lineHeight',
  'editor.letterSpacing',
  'editor.disableMonospaceOptimizations',
  'editor.renderLineHighlight',
  'editor.occurrencesHighlight',
  'editor.lineHighlightBackground',
  'editor.lineHighlightBorder',
  'editor.languageFonts',
])

// Prefixes whose whole subtree is owned elsewhere. `unicodeHighlight` is forced
// by FileEditor (CJK must never be flagged), so user overrides must not leak in.
const BESPOKE_PREFIXES = ['editor.unicodeHighlight.']

function isBespoke(key: string): boolean {
  if (BESPOKE_KEYS.has(key)) return true
  return BESPOKE_PREFIXES.some((p) => key.startsWith(p))
}

// Collect every registered editor.* key minus the bespoke ones. Computed lazily
// (not at module load) because the schema registers during BlockStartup, before
// which the registry is empty.
function bridgeKeys(): string[] {
  const keys: string[] = []
  for (const node of ConfigurationRegistry.getConfigurationNodes()) {
    for (const key of Object.keys(node.properties)) {
      if (key.startsWith('editor.') && !isBespoke(key)) keys.push(key)
    }
  }
  return keys
}

function setNested(target: Record<string, unknown>, path: string, value: unknown): void {
  // path is the part after the leading 'editor.', e.g. 'minimap.autohide'.
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    const next = cursor[key]
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {}
      cursor[key] = created
      cursor = created
    } else {
      cursor = next as Record<string, unknown>
    }
  }
  cursor[parts[parts.length - 1]!] = value
}

/**
 * Read every user-set bridged `editor.*` option and assemble the nested options
 * object for Monaco. Keys the user has not set are skipped so Monaco keeps its
 * own defaults.
 */
export function buildBridgedEditorOptions(
  config: IConfigurationService,
): monaco.editor.IEditorOptions {
  const options: Record<string, unknown> = {}
  for (const fullKey of bridgeKeys()) {
    const value = config.get(fullKey)
    if (value === undefined) continue
    setNested(options, fullKey.slice('editor.'.length), value)
  }
  return options as monaco.editor.IEditorOptions
}

/** Whether a config change touches any bridged editor option. */
export function affectsBridgedEditorOption(e: IConfigurationChangeEvent): boolean {
  for (const fullKey of bridgeKeys()) {
    if (e.affectsConfiguration(fullKey)) return true
  }
  return false
}
