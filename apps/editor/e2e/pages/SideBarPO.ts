import type { Page, Locator } from '@playwright/test'

export class SideBarPO {
  readonly root: Locator
  constructor(private readonly page: Page) {
    this.root = page.getByTestId('part-sidebar')
  }

  async activeContainerId(): Promise<string | undefined> {
    const id = await this.root.getAttribute('data-active-view-container')
    return id ?? undefined
  }
}
