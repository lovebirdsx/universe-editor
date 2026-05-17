import type { Page, Locator } from '@playwright/test'

export class SideBarPO {
  constructor(private readonly page: Page) {}

  readonly root: Locator = this.page.getByTestId('part-sidebar')

  async activeContainerId(): Promise<string | undefined> {
    const id = await this.root.getAttribute('data-active-view-container')
    return id ?? undefined
  }
}
