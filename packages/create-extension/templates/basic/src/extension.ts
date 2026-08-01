import { commands, window, type ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('__name__.helloWorld', () => {
      void window.showInformationMessage('Hello from __displayName__!')
    }),
  )
}

export function deactivate(): void {}
