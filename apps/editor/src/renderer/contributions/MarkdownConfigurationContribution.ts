/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the markdown.* settings: the preview's YAML frontmatter toggle and
 *  LaTeX math rendering, read by MarkdownPreviewEditor.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class MarkdownConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'markdown',
        title: localize('settings.markdown', 'Markdown'),
        properties: {
          'markdown.preview.renderYamlFrontmatter': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.markdown.preview.renderYamlFrontmatter',
              'Render YAML frontmatter (the `---` block at the top of a file) as a table in the markdown preview. When off, the frontmatter is hidden.',
            ),
          },
          'markdown.math.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.markdown.math.enabled',
              'Render LaTeX math (`$…$`, `$$…$$` and ```math fences) in the markdown preview.',
            ),
          },
          'markdown.math.macros': {
            type: 'object',
            default: {},
            additionalProperties: { type: 'string' },
            description: localize(
              'settings.markdown.math.macros',
              'Custom KaTeX macros available to every formula, keyed by macro name (e.g. { "\\RR": "\\mathbb{R}" }).',
            ),
          },
        },
      }),
    )
  }
}
