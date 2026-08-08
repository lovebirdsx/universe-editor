/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  commandId → extensionId attribution for extension-contributed commands.
 *  Registered by ExtensionPointTranslator when it mirrors an extension's static
 *  `contributes.commands` / `contributes.keybindings` into the core registries;
 *  read by the Keyboard Shortcuts editor to attribute a binding's Source column
 *  to the contributing extension.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'

const _commandSources = new Map<string, string>()

export function registerCommandSource(commandId: string, extensionId: string): IDisposable {
  _commandSources.set(commandId, extensionId)
  return toDisposable(() => {
    if (_commandSources.get(commandId) === extensionId) {
      _commandSources.delete(commandId)
    }
  })
}

export function getCommandSourceExtensionId(commandId: string): string | undefined {
  return _commandSources.get(commandId)
}
