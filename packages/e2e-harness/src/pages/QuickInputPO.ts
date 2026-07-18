import type { Page, Locator } from '@playwright/test'

export class QuickInputPO {
  readonly overlay: Locator
  readonly dialog: Locator
  readonly input: Locator

  constructor(page: Page) {
    this.overlay = page.getByTestId('quick-input-overlay')
    this.dialog = page.getByTestId('quick-input')
    this.input = page.getByTestId('quick-input-field')
  }

  async waitForVisible(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible' })
  }

  async waitForHidden(): Promise<void> {
    await this.dialog.waitFor({ state: 'hidden' })
  }
}
