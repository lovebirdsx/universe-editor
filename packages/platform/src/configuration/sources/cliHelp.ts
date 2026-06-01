/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders --help / --version text from declarative ConfigItems. Pure: no IO, no
 *  process/electron access — callers pass executable name, version and extra lines.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigItem } from './configSource.js'

export interface HelpMessageOptions {
  readonly executableName: string
  readonly version: string
  readonly items: readonly ConfigItem[]
}

export interface VersionMessageOptions {
  readonly productName: string
  readonly version: string
  readonly extraLines?: readonly string[]
}

/** `-h --help <arg>` style usage column for one option. */
function formatUsage(item: ConfigItem): string {
  const flags = item.cliAlias ? `-${item.cliAlias} --${item.cli}` : `--${item.cli}`
  return item.args ? `${flags} ${item.args}` : flags
}

/** Build the `--help` text. Only items with both a `cli` flag and a `description`
 *  are listed; everything is aligned into two columns. */
export function buildHelpMessage(opts: HelpMessageOptions): string {
  const options = opts.items.filter((i) => i.cli && i.description)
  const usages = options.map(formatUsage)
  const width = usages.reduce((max, u) => Math.max(max, u.length), 0)

  const lines = [
    `${opts.executableName} ${opts.version}`,
    '',
    `Usage: ${opts.executableName} [options]`,
    '',
    'Options:',
    ...options.map((item, i) => `  ${usages[i]!.padEnd(width)}  ${item.description}`),
  ]
  return lines.join('\n')
}

/** Build the `--version` text: `<productName> <version>` plus any extra lines. */
export function buildVersionMessage(opts: VersionMessageOptions): string {
  return [`${opts.productName} ${opts.version}`, ...(opts.extraLines ?? [])].join('\n')
}
