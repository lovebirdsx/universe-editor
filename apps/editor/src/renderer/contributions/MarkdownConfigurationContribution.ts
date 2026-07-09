/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the markdown.* settings. Currently the preview's YAML frontmatter
 *  rendering toggle, read by MarkdownPreviewEditor.
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
        },
      }),
    )
  }
}
