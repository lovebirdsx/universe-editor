import { commands, window, type ExtensionContext } from '@universe-editor/extension-api'

// Called once, when the `onCommand:hello-world.helloWorld` activation event
// fires (i.e. the first time somebody runs the command). Everything the
// extension registers must be pushed into context.subscriptions so the host
// can dispose it on shutdown.
export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('hello-world.helloWorld', () => {
      void window.showInformationMessage('Hello from Hello World!')
    }),
  )
}

// Best-effort synchronous cleanup hook. Most extensions can rely on
// context.subscriptions disposal and leave this empty.
export function deactivate(): void {}
