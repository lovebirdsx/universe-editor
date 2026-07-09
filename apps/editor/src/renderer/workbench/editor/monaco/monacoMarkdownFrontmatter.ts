/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adds YAML frontmatter highlighting to Monaco's built-in markdown Monarch
 *  grammar. The stock grammar treats the leading `---` block as a horizontal
 *  rule / setext heading, so keys and values inside the preamble share the plain
 *  text colour. We clone the built-in language, add a document-start state that
 *  recognises a frontmatter block and colours its `key: value` pairs (keys as
 *  `type`, values as `string`, matching how YAML renders elsewhere), then
 *  override the markdown tokens provider with the patched grammar.
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'

type MonarchLanguage = monaco.languages.IMonarchLanguage

/**
 * A document-start state that only fires on the first line. If it is `---` we
 * enter the frontmatter block; otherwise we hand the line back to the normal
 * markdown `root` state. Because `start` runs once, a bare `---` elsewhere in the
 * body still tokenizes as a horizontal rule.
 */
function patchMarkdownLanguage(base: MonarchLanguage): MonarchLanguage {
  const tokenizer = base.tokenizer as Record<string, unknown>
  return {
    ...base,
    start: 'frontmatter_start',
    tokenizer: {
      ...tokenizer,
      frontmatter_start: [
        [/^---[ \t]*$/, { token: 'operators', switchTo: '@frontmatter' }],
        [/.*/, { token: '@rematch', switchTo: '@root' }],
      ],
      frontmatter: [
        // Closing fence — hand the rest of the document to the markdown body.
        [/^(?:---|\.\.\.)[ \t]*$/, { token: 'operators', switchTo: '@root' }],
        [/#.*$/, 'comment'],
        // `key:` — the key becomes a `type` token so it colours distinctly from
        // the value. Quoted or plain keys, optional trailing value on the line.
        [
          /^(\s*)("[^"]*"|'[^']*'|[^:#\s][^:#]*?)(\s*)(:)(\s|$)/,
          ['white', 'type', 'white', 'operators', 'white'],
        ],
        // Sequence item marker.
        [/^\s*-(?=\s)/, 'operators'],
        // Anything else on the line is a value/scalar.
        [/.+$/, 'string'],
      ],
    },
  }
}

/**
 * Register the frontmatter-aware markdown grammar. Monaco's built-in markdown is
 * installed as a *lazy tokens-provider factory* (basic-languages `_.contribution`
 * calls `registerTokensProviderFactory`), not `setMonarchTokensProvider`. So we
 * replace that factory: `registerTokensProviderFactory` disposes the previously
 * registered factory for the language and installs ours, which lazily imports the
 * built-in grammar and returns the patched clone the first time a markdown model
 * is tokenized. Doing it this way (rather than `setMonarchTokensProvider`, which
 * eagerly `register()`s a support) avoids a race where triggering the built-in
 * factory's async resolution overwrites an eagerly-registered override.
 */
export function registerMarkdownFrontmatterHighlight(m: typeof monaco): void {
  m.languages.registerTokensProviderFactory('markdown', {
    create: async () => {
      const builtIn = await import('monaco-editor/esm/vs/basic-languages/markdown/markdown.js')
      return patchMarkdownLanguage(builtIn.language)
    },
  })
}
