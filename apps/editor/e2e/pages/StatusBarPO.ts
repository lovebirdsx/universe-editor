import type { Page, Locator } from '@playwright/test'

export class StatusBarPO {
  constructor(private readonly page: Page) {}

  readonly root: Locator = this.page.getByTestId('part-statusbar')

  async entriesFromProbe(): Promise<Array<{ id: string; text: string; alignment: 'left' | 'right' }>> {
    return this.page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  }
}
