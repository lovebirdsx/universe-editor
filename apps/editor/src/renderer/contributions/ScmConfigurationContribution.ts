/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the scm.* settings — provider-neutral SCM settings shared by every
 *  source-control extension (blame rendering and the dirty-diff decorations are
 *  renderer-side, so their settings live here rather than in the git extension).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

const TEMPLATE_TOKENS =
  '${hash}, ${hashShort}, ${subject}, ${authorName}, ${authorEmail}, ${authorDate}, ${authorDateAgo}'

export class ScmConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'scm',
        title: localize('settings.scm', 'Source Control'),
        properties: {
          'scm.diffDecorations': {
            type: 'string',
            enum: ['all', 'gutter', 'overview', 'minimap', 'none'],
            enumDescriptions: [
              localize(
                'settings.scm.diffDecorations.all',
                'Show the diff decorations in all available locations.',
              ),
              localize(
                'settings.scm.diffDecorations.gutter',
                'Show the diff decorations only in the editor gutter.',
              ),
              localize(
                'settings.scm.diffDecorations.overview',
                'Show the diff decorations only in the overview ruler.',
              ),
              localize(
                'settings.scm.diffDecorations.minimap',
                'Show the diff decorations only in the minimap.',
              ),
              localize('settings.scm.diffDecorations.none', 'Do not show the diff decorations.'),
            ],
            default: 'all',
            description: localize(
              'settings.scm.diffDecorations',
              'Controls diff decorations in the editor.',
            ),
          },
          'scm.blame.editorDecoration.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.scm.blame.editorDecoration.enabled',
              'Show the blame information for the line the cursor is on at the end of the line.',
            ),
          },
          'scm.blame.editorDecoration.template': {
            type: 'string',
            default: '${subject}, ${authorName} (${authorDateAgo})',
            description: localize(
              'settings.scm.blame.editorDecoration.template',
              `Template for the inline blame annotation. Tokens: ${TEMPLATE_TOKENS}.`,
            ),
          },
          'scm.blame.editorDecoration.disableHover': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.scm.blame.editorDecoration.disableHover',
              'Disable the hover that shows full commit info when pointing at the inline blame annotation.',
            ),
          },
          'scm.blame.statusBarItem.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.scm.blame.statusBarItem.enabled',
              'Show the blame information for the line the cursor is on in the status bar.',
            ),
          },
          'scm.blame.statusBarItem.template': {
            type: 'string',
            default: '${authorName} (${authorDateAgo})',
            description: localize(
              'settings.scm.blame.statusBarItem.template',
              `Template for the blame information status bar item. Tokens: ${TEMPLATE_TOKENS}.`,
            ),
          },
          'scm.blame.ignoreWhitespace': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.scm.blame.ignoreWhitespace',
              'Ignore whitespace changes when computing blame information.',
            ),
          },
          'scm.mergeEditor': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.scm.mergeEditor',
              'Open conflicted files in the 3-way merge editor. When false, conflicts open as a working-tree diff and are resolved inline via conflict markers.',
            ),
          },
        },
      }),
    )
  }
}
