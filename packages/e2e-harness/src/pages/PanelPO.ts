import { expect, type Page, type Locator } from '@playwright/test'

export class PanelPO {
  readonly root: Locator
  constructor(private readonly page: Page) {
    this.root = page.getByTestId('part-panel')
  }

  tab(id: string): Locator {
    return this.page.getByTestId(`view-container-tab-${id}`)
  }

  /**
   * Panel visibility is driven by the Allotment.Pane wrapper in WorkbenchLayout
   * (which hides via CSS visibility), so descendant DOM-visibility checks lag
   * behind the actual UI state. Use the `panelVisible` context key — that is
   * the source of truth maintained by ContextKeyContribution.
   */
  async waitForVisible(): Promise<void> {
    await expect
      .poll(() => this.page.evaluate(() => window.__E2E__!.getContextKey('panelVisible')))
      .toBe(true)
    await this.root.waitFor({ state: 'attached' })
  }

  async waitForActiveTab(id: string): Promise<void> {
    await expect(this.tab(id)).toHaveAttribute('aria-selected', 'true')
  }
}
