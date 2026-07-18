import type { Page, Locator } from '@playwright/test'

export class EditorAreaPO {
  readonly fileEditor: Locator
  readonly monacoEditor: Locator

  constructor(private readonly page: Page) {
    this.fileEditor = page.getByTestId('file-editor')
    this.monacoEditor = page.locator('.monaco-editor').first()
  }

  async activeUri(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  }
}
