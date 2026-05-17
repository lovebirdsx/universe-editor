import type { Page, Locator } from '@playwright/test'

export class EditorAreaPO {
  constructor(private readonly page: Page) {}

  readonly fileEditor: Locator = this.page.getByTestId('file-editor')
  readonly monacoEditor: Locator = this.page.locator('.monaco-editor').first()

  async activeUri(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  }
}
