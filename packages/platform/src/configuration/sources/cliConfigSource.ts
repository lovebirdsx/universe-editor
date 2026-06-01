/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CLI argv source. Supports `--key value`, `--key=value`, boolean `--flag`, and the
 *  short alias forms `-k value`, `-k=value`, `-k`. A bare flag followed by another
 *  flag (or end of argv) is treated as a present boolean flag, and does NOT consume
 *  the next token as its value.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigItem, IConfigSource, RawConfigValue } from './configSource.js'

export class CliConfigSource implements IConfigSource {
  readonly name = 'cli'

  constructor(private readonly _argv: readonly string[]) {}

  getRawValue(item: ConfigItem): RawConfigValue {
    if (!item.cli) return undefined

    const forms = [`--${item.cli}`]
    if (item.cliAlias) forms.push(`-${item.cliAlias}`)

    for (let i = 0; i < this._argv.length; i++) {
      const arg = this._argv[i]!
      const eqForm = forms.find((f) => arg.startsWith(`${f}=`))
      if (eqForm) {
        return arg.slice(eqForm.length + 1)
      }
      if (forms.includes(arg)) {
        if (item.type === 'boolean') return true
        const next = this._argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) return next
        // Present but valueless: a boolean-ish presence for non-boolean items
        // yields no usable value, so fall through to undefined.
        return undefined
      }
    }
    return undefined
  }
}
