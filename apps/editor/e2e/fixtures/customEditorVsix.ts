/*---------------------------------------------------------------------------------------------
 *  A minimal custom-editor extension `.vsix` shared by the webview specs.
 *
 *  Registers a provider for `*.uecustom`, renders inline HTML (with a marker the
 *  test can assert), loads a stylesheet through `asWebviewUri`, runs an inline
 *  <script> under its own CSP, echoes messages posted from inside the iframe, and
 *  stamps a marker from a pdf.js-style capture print listener (used to prove the
 *  host bootstrap stops native shortcuts).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import AdmZip from 'adm-zip'

export const VIEW_TYPE = 'e2eCustom.view'
export const MARKER = 'e2e-custom-editor-rendered'
/** A distinctive colour set only by the asWebviewUri-served stylesheet. */
export const MARKER_COLOR = 'rgb(1, 2, 3)'
/** Text an inline <script> writes — proves inline scripts actually run (see below). */
export const SCRIPT_MARKER = 'e2e-inline-script-ran'
/** Marker element a pdf.js-style capture keydown listener would stamp on Ctrl+P. */
export const PRINT_MARKER = 'e2e-webview-print-fired'
/** Receives the host's echo of a message posted from inside the iframe. */
export const ECHO_MARKER = 'e2e-webview-echo'

/** A restricted-tier extension that registers a custom editor for `*.uecustom`. */
export async function makeCustomEditorVsix(dir: string): Promise<string> {
  const manifest = {
    name: 'e2e-custom-editor',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    activationEvents: [`onCustomEditor:${VIEW_TYPE}`],
    contributes: {
      customEditors: [
        {
          viewType: VIEW_TYPE,
          displayName: 'E2E Custom',
          selector: [{ filenamePattern: '*.uecustom' }],
        },
      ],
    },
  }

  // Plain CJS module; the host imports it and calls activate(). Installed
  // extensions have no node_modules, so instead of importing the api package it
  // talks to the host bridge global directly (same object the api delegates to).
  // The HTML links a stylesheet the extension serves through asWebviewUri, so the
  // test can confirm `universe-app://` sub-resources actually load (not just that
  // the inline HTML rendered). It also declares its OWN CSP (allowing inline
  // scripts) and runs an inline <script> that stamps a marker: this guards the
  // CSP-inheritance root cause — an about:blank iframe would inherit the shell's
  // strict `script-src 'self'` and refuse this inline script, so the marker would
  // never appear.
  const source = `
    const path = require('node:path')
    const bridge = globalThis['__universeExtensionHostBridge__']
    function fileUri(fsPath) {
      const forward = fsPath.replace(/\\\\/g, '/')
      return { scheme: 'file', path: forward.startsWith('/') ? forward : '/' + forward }
    }
    exports.activate = (context) => {
      const cssUriComponents = fileUri(path.join(context.extensionPath, 'assets', 'marker.css'))
      context.subscriptions.push(
        bridge.registerCustomEditorProvider(${JSON.stringify(VIEW_TYPE)}, {
          openCustomDocument: (uri) => ({ uri, dispose() {} }),
          resolveCustomEditor: (_doc, panel) => {
            panel.webview.options = {
              enableScripts: true,
              localResourceRoots: [fileUri(context.extensionPath)],
            }
            // Echo round-trip: iframe → host listener → extension → iframe. The
            // host-side message listener must live on the window that owns the
            // iframe, which changes when the editor moves to an auxiliary window.
            panel.webview.onDidReceiveMessage((msg) => {
              panel.webview.postMessage({ echo: msg && msg.ping })
            })
            const cssUrl = panel.webview.asWebviewUri(cssUriComponents)
            panel.webview.html =
              '<!DOCTYPE html><html><head>' +
              '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; ' +
              'style-src ' + panel.webview.cspSource + '; script-src \\'unsafe-inline\\';">' +
              '<link rel="stylesheet" href="' + cssUrl + '">' +
              '</head><body>' +
              '<div id="${MARKER}">ok</div>' +
              '<div id="${SCRIPT_MARKER}"></div>' +
              '<div id="${PRINT_MARKER}"></div>' +
              '<div id="${ECHO_MARKER}"></div>' +
              '<script>document.getElementById(${JSON.stringify(SCRIPT_MARKER)}).textContent = "ran"</script>' +
              '<script>window.addEventListener("message", function(e){' +
              'if(e.data && e.data.echo){' +
              'document.getElementById(${JSON.stringify(ECHO_MARKER)}).textContent=String(e.data.echo);}})</script>' +
              // pdf.js-style capture-phase print listener: stamps a marker on
              // Ctrl+P. The host bootstrap must stopImmediatePropagation it, so
              // this must NOT fire even though the key is a real Ctrl+P.
              '<script>window.addEventListener("keydown", function(e){' +
              'if((e.ctrlKey||e.metaKey)&&e.keyCode===80){' +
              'document.getElementById(${JSON.stringify(PRINT_MARKER)}).textContent="printed";}}, true);' +
              '</script>' +
              '</body></html>'
          },
        }),
      )
    }
    exports.deactivate = () => {}
  `

  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('extension/dist/extension.js', Buffer.from(source))
  zip.addFile('extension/assets/marker.css', Buffer.from(`#${MARKER} { color: ${MARKER_COLOR}; }`))
  const vsixPath = path.join(dir, 'e2e-custom-editor.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}
