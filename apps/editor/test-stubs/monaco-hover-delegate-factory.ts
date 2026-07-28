/* Test stub for monaco's deep hoverDelegateFactory ESM path. The hover guard
 * (monacoHoverDelegateGuard) reseats the global factory on editor dispose; in
 * happy-dom tests the module-level record lets a test inspect what was last
 * installed.
 */

export const hoverDelegateFactoryStubState: { installedFactory: unknown } = {
  installedFactory: undefined,
}

export function setHoverDelegateFactory(factory: unknown): void {
  hoverDelegateFactoryStubState.installedFactory = factory
}
