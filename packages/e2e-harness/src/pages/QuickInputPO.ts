import type { Page, Locator } from '@playwright/test'

export class QuickInputPO {
  readonly overlay: Locator
  readonly dialog: Locator
  readonly input: Locator
  /** Quick-navigate footer hint; only rendered while the picker is locked. */
  readonly hint: Locator

  constructor(page: Page) {
    this.overlay = page.getByTestId('quick-input-overlay')
    this.dialog = page.getByTestId('quick-input')
    this.input = page.getByTestId('quick-input-field')
    this.hint = page.getByTestId('quick-input-hint')
  }

  async waitForVisible(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible' })
  }

  async waitForHidden(): Promise<void> {
    await this.dialog.waitFor({ state: 'hidden' })
  }
}
