/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewElement — hosts an extension-provided webview inside a sandboxed iframe.
 *  Our equivalent of VSCode's webview <iframe>. The extension sets `webview.html`
 *  (host side); we render it as the iframe's document and bridge `postMessage`
 *  both ways.
 *
 *  Origin model (see main/ipc/resourceProtocol.ts): local resources are served
 *  from the single `universe-app://root` origin, and a secure custom scheme
 *  refuses cross-origin sub-resource loads. A `srcdoc`/`about:blank` iframe is a
 *  null/opaque origin, so it could not load `universe-app://root/_resource_/...`
 *  assets that `asWebviewUri` produces. We therefore navigate the iframe to a
 *  real blank document ON the app origin (WEBVIEW_BLANK_URL).
 *
 *  Why a real navigated URL and NOT `about:blank` + doc.write: a local-scheme
 *  document with no src inherits its creator's (the app shell's) CSP, and CSP
 *  can only be tightened, never loosened — so the extension's own `<meta>` CSP
 *  would be pinned under the shell's strict `script-src 'self'` and pdf.js-style
 *  module/inline scripts would be refused. The blank document is served WITHOUT a
 *  CSP header, so once loaded the extension's injected CSP is the only one in
 *  effect.
 *
 *  Why we postMessage the HTML instead of writing the iframe directly: in dev the
 *  shell is `http://localhost` while the frame is `universe-app://root`, so they
 *  are cross-origin and `iframe.contentDocument.write` throws ("Can only call
 *  open() on same-origin documents"). The blank document ships a tiny loader — a
 *  persistent `window` message listener — that receives the HTML via
 *  WEBVIEW_SETUP_MARKER and does the same-origin write itself. `document.write`
 *  replaces the document body but NOT the window listener, so the loader keeps
 *  accepting later hand-offs (the extension replacing `webview.html`, or a
 *  re-resolve after the tab was hidden) without the iframe ever being rebuilt.
 *  Keeping ONE iframe per panel is what fixes the "hide then reveal → blank"
 *  race: `frameLoaded` is bound to that single iframe, so we never postMessage to
 *  a freshly-swapped frame whose loader hasn't registered yet.
 *
 *  Sandboxed with `allow-scripts allow-same-origin` so scripts run and
 *  same-origin resource loads resolve. This is NOT a hard security boundary — an
 *  external extension's webview runs with roughly the extension's own privileges;
 *  the real guards are the CSP the extension declares plus the resource
 *  allow-list (only files under granted roots are served). Do not describe this
 *  as a sandbox in user docs.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { WEBVIEW_BLANK_URL, WEBVIEW_SETUP_MARKER } from '@universe-editor/extensions-common'
import { IContextKeyService } from '@universe-editor/platform'
import { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import { WebviewFocusRegistry } from '../../services/editor/WebviewFocusRegistry.js'
import { syncEditorFocusContext } from '../../services/editor/editorFocus.js'
import { useObservable, useOptionalService, useService } from '../useService.js'
import type { IWebviewPanelModel } from '../../services/extensions/WebviewService.js'
import styles from './WebviewElement.module.css'

/** Marker on messages the host frame exchanges with the iframe bootstrap. */
const CHANNEL = '__universe_webview__'
/** Marker on keydown messages the iframe forwards up so host keybindings run. */
const KEY_CHANNEL = '__universe_webview_key__'

export function WebviewElement({ panel }: { panel: IWebviewPanelModel }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const resourceAccess = useOptionalService(IResourceAccessService)
  const contextKeyService = useService(IContextKeyService)
  const html = useObservable(panel.html)
  const options = useObservable(panel.options)
  // True once the iframe finished loading WEBVIEW_BLANK_URL (its loader listener
  // is then live). Bound to this single, never-rebuilt iframe, so it stays valid
  // for every later HTML hand-off. We only postMessage the HTML after this flips.
  const [frameLoaded, setFrameLoaded] = useState(false)

  // Grant the app protocol read access to the declared roots, THEN hand the HTML
  // to the frame. Both run against the main process, but over different channels:
  // the grant is an `IResourceAccessService` RPC while the iframe's
  // `universe-app://` sub-resource requests hit the protocol handler directly. If
  // we sent the HTML first, those requests could reach the handler before the
  // allow-list grant landed and get 403'd (a pdf.js viewer then shows its chrome
  // but no document). Awaiting the grant here orders it first. The loader inside
  // the blank document performs the actual same-origin `document.write`; because
  // that write leaves the loader's window listener in place, re-sending the HTML
  // (extension replaced it, or the tab was hidden and revealed) just works.
  useEffect(() => {
    if (!frameLoaded) return
    if (html === '') return
    let cancelled = false
    const send = async () => {
      const roots = options.localResourceRoots ?? []
      if (resourceAccess && roots.length > 0) await resourceAccess.allowRoots(roots)
      if (cancelled) return
      iframeRef.current?.contentWindow?.postMessage(
        { [WEBVIEW_SETUP_MARKER]: true, html: injectBootstrap(html) },
        '*',
      )
    }
    void send()
    return () => {
      cancelled = true
    }
  }, [resourceAccess, html, options, frameLoaded])

  // Bridge messages: iframe → host (WebviewService → ext host), and
  // host → iframe (WebviewService.onMessageToWebview → iframe.postMessage).
  useEffect(() => {
    const onWindowMessage = (e: MessageEvent) => {
      const data = e.data as { [CHANNEL]?: boolean; payload?: unknown } | null
      if (!data || data[CHANNEL] !== true) return
      if (e.source !== iframeRef.current?.contentWindow) return
      panel.postMessageFromWebview(data.payload)
    }
    window.addEventListener('message', onWindowMessage)
    const sub = panel.onMessageToWebview((payload) => {
      iframeRef.current?.contentWindow?.postMessage({ [CHANNEL]: true, payload }, '*')
    })
    return () => {
      window.removeEventListener('message', onWindowMessage)
      sub.dispose()
    }
  }, [panel])

  // Register a focus controller so `CustomEditorInput.focus()` (invoked when the
  // editor group activates or a hidden tab is revealed) can move keyboard focus
  // INTO the iframe. Without it focusEditorInput falls back to the group body and
  // the webview stays unfocused until clicked.
  //
  // Focus timing is subtle: the iframe first loads the blank bootstrap doc, then
  // the loader's `document.write` rebuilds the document with the extension HTML —
  // which DROPS any focus applied to the blank doc, and the extension's own
  // scripts (e.g. pdf.js) initialise asynchronously afterwards. So we record the
  // intent in `wantFocusRef` and re-apply focus AFTER the HTML has been written
  // and settled (the delayed effect below), mirroring VSCode's deferred
  // `_doFocus`. Focusing the iframe leaves the host's `editorTextFocus` /
  // `editorFocus` context keys possibly stuck true (a prior Monaco editor's blur
  // can lag), which would make the global keybinding handler treat the webview as
  // a text surface and swallow forwarded keys — so we clear them via
  // syncEditorFocusContext.
  const wantFocusRef = useRef(false)
  const applyFocus = useCallback(
    (clearIntent: boolean) => {
      if (!wantFocusRef.current) return
      const frame = iframeRef.current
      const win = frame?.contentWindow
      if (!frame || !win) return
      frame.focus()
      win.focus()
      if (clearIntent) wantFocusRef.current = false
      syncEditorFocusContext(contextKeyService)
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    },
    [contextKeyService],
  )

  useEffect(() => {
    const controller = {
      focus: () => {
        wantFocusRef.current = true
        applyFocus(false)
      },
    }
    WebviewFocusRegistry.register(panel.viewType, panel.resource, controller)
    return () => WebviewFocusRegistry.unregister(panel.viewType, panel.resource, controller)
  }, [panel, applyFocus])

  // Re-apply a pending focus once the extension HTML has been written into the
  // iframe and had a moment to settle. The `send` effect above posts the HTML to
  // the loader, which `document.write`s it (rebuilding the doc and dropping focus);
  // this delayed pass lands focus on the real content, not the transient blank
  // doc. Keyed on `html` so a re-resolve (extension replaced the HTML, or the tab
  // was hidden and revealed) re-focuses too.
  useEffect(() => {
    if (!frameLoaded || html === '' || !wantFocusRef.current) return
    const t = setTimeout(() => applyFocus(true), 80)
    return () => clearTimeout(t)
  }, [frameLoaded, html, applyFocus])

  // Replay keystrokes the iframe forwarded up. Keyboard events do not cross the
  // iframe boundary, so while focus is inside the webview the document-level
  // global keybinding handler never sees them and every host shortcut (Ctrl+W,
  // Ctrl+P, …) dies. The injected bootstrap forwards keydowns that carry a
  // functional modifier (the only keys host keybindings use); we synthesize an
  // equivalent event and dispatch it on the iframe element, so it bubbles through
  // the host document and the capture-phase handler resolves it with `e.target` =
  // the iframe (a non-editable surface). Mirrors VSCode's did-keydown replay
  // (workaround for keyboard events not bubbling out of a webview).
  useEffect(() => {
    const onKeyMessage = (e: MessageEvent) => {
      const data = e.data as { [KEY_CHANNEL]?: boolean; init?: KeyboardEventInit } | null
      if (!data || data[KEY_CHANNEL] !== true || !data.init) return
      if (e.source !== iframeRef.current?.contentWindow) return
      const target = iframeRef.current
      if (!target) return
      const replay = new KeyboardEvent('keydown', {
        ...data.init,
        bubbles: true,
        cancelable: true,
      })
      target.dispatchEvent(replay)
    }
    window.addEventListener('message', onKeyMessage)
    return () => window.removeEventListener('message', onKeyMessage)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      className={styles['webviewFrame']}
      data-testid="webview-frame"
      // Navigate to a real same-origin blank doc (NOT about:blank) so the
      // extension's <meta> CSP governs the frame; see header. The HTML is handed
      // to the doc's loader by postMessage once `frameLoaded` flips. The iframe is
      // never rebuilt — the loader survives document.write and accepts re-sends.
      src={WEBVIEW_BLANK_URL}
      onLoad={() => setFrameLoaded(true)}
      // allow-same-origin so `universe-app://root` sub-resources load; see header.
      sandbox="allow-scripts allow-same-origin"
      title={panel.viewType}
    />
  )
}

/**
 * Inject the message-bridge bootstrap into the extension's HTML. The bootstrap
 * exposes `acquireVsCodeApi()`-shaped `postMessage`, forwards `window` messages
 * so scripts inside the iframe talk to the host via the CHANNEL marker, and
 * forwards modifier keystrokes up so host keybindings (Ctrl+W, Ctrl+P, …) keep
 * working while focus is inside the webview (keyboard events don't cross the
 * iframe boundary). Injected just after <head> so it runs before the page's own
 * scripts.
 *
 * Crucially, keystrokes that would trigger a BROWSER-native action (print,
 * find, save, undo/redo) are suppressed in the iframe before being forwarded —
 * otherwise Ctrl+P fires BOTH the host's Go to File AND the webview's own print.
 * We use `stopImmediatePropagation()` + `preventDefault()` (not just
 * preventDefault): pdf.js registers a capture-phase `window` keydown listener
 * that calls `window.print()` DIRECTLY (not a native default we could cancel),
 * so only stopping propagation to its listener works. Our bootstrap runs before
 * the page's own scripts (injected right after <head>) and also listens in the
 * capture phase, so it fires first and can stop the chain. This mirrors VSCode's
 * webview `handleInnerKeydown` (see vscode `webview/browser/pre/index.html`).
 * Plain typing (a key with no ctrl/alt/meta) stays entirely in the webview.
 */
function injectBootstrap(html: string): string {
  const bootstrap = `<script>(function(){
    const CH = ${JSON.stringify(CHANNEL)};
    const KEY_CH = ${JSON.stringify(KEY_CHANNEL)};
    const api = {
      postMessage: function(msg){ parent.postMessage({ [CH]: true, payload: msg }, '*'); },
      getState: function(){ return undefined; },
      setState: function(){},
    };
    window.acquireVsCodeApi = function(){ return api; };
    window.acquireUniverseApi = window.acquireVsCodeApi;
    window.addEventListener('message', function(e){
      const d = e.data;
      if (!d || d[CH] !== true) return;
      window.dispatchEvent(new MessageEvent('message', { data: d.payload }));
    });
    // Suppress in-webview shortcuts the host owns, so e.g. Ctrl+P doesn't also
    // pop the webview's own (pdf.js) print. keyCodes: P=80 F=70 S=83 Z=90 Y=89
    // (with ctrl/meta). Matches VSCode's isPrint/isFind/isSave/isUndoRedo.
    function isNativeShortcut(e){
      const meta = e.ctrlKey || e.metaKey;
      return meta && (e.keyCode === 80 || e.keyCode === 70 || e.keyCode === 83
        || e.keyCode === 90 || e.keyCode === 89);
    }
    // Forward keystrokes the host needs to the parent. Plain typing (no
    // ctrl/alt/meta) stays in the webview; everything with a functional modifier
    // is a potential host shortcut, so replay it up.
    window.addEventListener('keydown', function(e){
      if (e.isComposing) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
      if (isNativeShortcut(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
      parent.postMessage({ [KEY_CH]: true, init: {
        key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
        keyCode: e.keyCode, which: e.which,
      } }, '*');
    }, true);
  })();</script>`
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${bootstrap}`)
  }
  return `${bootstrap}${html}`
}
