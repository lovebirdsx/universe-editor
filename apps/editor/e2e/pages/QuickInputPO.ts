import type { Page, Locator } from '@playwright/test'

export class QuickInputPO {
  constructor(private readonly page: Page) {}

  readonly overlay: Locator = this.page.getByTestId('quick-input-overlay')
  readonly dialog: Locator = this.page.getByTestId('quick-input')
  readonly input: Locator = this.page.getByTestId('quick-input-field')

  async waitForVisible(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible' })
  }

  async waitForHidden(): Promise<void> {
    await this.dialog.waitFor({ state: 'hidden' })
  }
}
