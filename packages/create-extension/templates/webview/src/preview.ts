import type { CustomDocument, UriComponents } from '@universe-editor/extension-api'

/** Join POSIX-style path segments onto a base path. */
export function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...segments].join('/')
}

/** Build a `file:` UriComponents for an absolute filesystem path. */
export function fileUri(fsPath: string): UriComponents {
  const forward = fsPath.replace(/\\/g, '/')
  return { scheme: 'file', path: forward.startsWith('/') ? forward : `/${forward}` }
}

/** The directory portion of a `file:` UriComponents, as a `file:` UriComponents. */
export function dirUri(uri: UriComponents): UriComponents {
  const p = uri.path ?? ''
  const slash = p.lastIndexOf('/')
  return { scheme: 'file', path: slash > 0 ? p.slice(0, slash) : '/' }
}

export class PreviewDocument implements CustomDocument {
  constructor(readonly uri: UriComponents) {}
  dispose(): void {
    // Nothing held — see the PDF sample for when a document needs cleanup.
  }
}

export function renderHtml(document: PreviewDocument): string {
  const fileName = document.uri.path?.split('/').pop() ?? ''
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>__displayName__ Preview</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; }
      code { background: rgba(127, 127, 127, 0.2); padding: 0.1em 0.3em; border-radius: 3px; }
    </style>
  </head>
  <body>
    <h1>__displayName__</h1>
    <p>Previewing <code>${fileName}</code>.</p>
    <p>Replace this static HTML with your own renderer.</p>
  </body>
</html>`
}
