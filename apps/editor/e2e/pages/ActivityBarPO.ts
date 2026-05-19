import type { Page, Locator } from '@playwright/test'

export class ActivityBarPO {
  readonly root: Locator

  constructor(private readonly page: Page) {
    this.root = page.getByTestId('part-activitybar')
  }

  item(containerId: string): Locator {
    return this.page.getByTestId(`activitybar-item-${containerId}`)
  }

  async click(containerId: string): Promise<void> {
    await this.item(containerId).click()
  }

  async activeContainerId(): Promise<string | undefined> {
    const id = await this.page.evaluate(
      () =>
        document.querySelector<HTMLElement>('[data-testid="part-sidebar"]')?.dataset[
          'activeViewContainer'
        ],
    )
    return id ?? undefined
  }
}
