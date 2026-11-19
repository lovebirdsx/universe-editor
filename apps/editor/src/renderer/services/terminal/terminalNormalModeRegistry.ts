/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registry of live terminal Normal Mode controllers. The Terminal Normal
 *  commands act on the terminal that owns DOM focus; the command handlers run
 *  outside React, so the instance list has to live in a module-level registry
 *  (same pattern as the Keybindings editor runtime handle).
 *--------------------------------------------------------------------------------------------*/

export interface ITerminalNormalModeController {
  readonly surfaceKey: string
  getElement(): HTMLElement | null
  isNormalMode(): boolean
  enterNormalMode(): boolean
  exitNormalMode(): boolean
  cancelSelection(): void
  startSelection(): void
  scrollLines(amount: number, count?: number): void
  scrollHalfPage(direction: 'up' | 'down', count?: number): void
  scrollPage(direction: 'up' | 'down', count?: number): void
  scrollToTop(): void
  scrollToBottom(): void
  copySelection(): Promise<boolean>
}

const controllers = new Set<ITerminalNormalModeController>()

export function registerTerminalNormalModeController(controller: ITerminalNormalModeController): {
  dispose(): void
} {
  controllers.add(controller)
  return {
    dispose: () => {
      controllers.delete(controller)
    },
  }
}

/**
 * The controller whose host currently contains `document.activeElement` in its
 * own document. Reading the element at call time keeps auxiliary windows and
 * terminals reparented between panel/editor working without re-registration.
 */
export function getFocusedTerminalNormalModeController():
  | ITerminalNormalModeController
  | undefined {
  for (const controller of controllers) {
    const element = controller.getElement()
    if (element === null) continue
    const active = element.ownerDocument.activeElement
    if (active !== null && element.contains(active)) return controller
  }
  return undefined
}

/** Test-only: forget every registered controller. */
export function __resetTerminalNormalModeControllersForTests(): void {
  controllers.clear()
}
