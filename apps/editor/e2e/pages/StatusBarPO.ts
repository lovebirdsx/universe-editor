import type { Page, Locator } from '@playwright/test'

export class StatusBarPO {
  readonly root: Locator
  constructor(private readonly page: Page) {
    this.root = page.getByTestId('part-statusbar')
  }

  async entriesFromProbe(): Promise<
    Array<{ id: string; text: string; alignment: 'left' | 'right'; icon?: string }>
  > {
    return this.page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  }
}
