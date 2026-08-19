import { commands, window, type ExtensionContext } from '@universe-editor/extension-api'
import { getHelloMessage } from './hello.js'

export function activate(context: ExtensionContext): void {
  const output = window.createOutputChannel('__displayName__')
  context.subscriptions.push(
    output,
    commands.registerCommand('__name__.helloWorld', () => {
      output.appendLine(getHelloMessage())
      void window.showInformationMessage(getHelloMessage())
    }),
  )
}

export function deactivate(): void {}
