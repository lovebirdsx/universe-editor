/* Test stub for monaco's deep platform hover ESM path. The hover guard
 * (monacoHoverDelegateGuard) builds WorkbenchHoverDelegate through the root
 * instantiation service; happy-dom tests only need a disposable placeholder.
 */

export class WorkbenchHoverDelegate {
  constructor(
    public readonly placement: string,
    public readonly hoverOptions: unknown,
    public readonly overrideOptions: unknown,
  ) {}
  dispose(): void {}
}

export const IHoverService = { id: 'hoverService' }
