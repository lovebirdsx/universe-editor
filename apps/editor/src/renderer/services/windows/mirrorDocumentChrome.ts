/*---------------------------------------------------------------------------------------------
 *  Mirror the main window's document chrome into an auxiliary window.
 *
 *  Auxiliary windows are the same-origin `about:blank` popups; they start with an
 *  empty document. The workbench's CSS (Vite <link>s in production, injected
 *  <style>s in dev/HMR), the theme service's injected variables and the
 *  document/body classes that carry theme + icon gates all live in the main
 *  document, so they must be copied one-way. A `<base>` pointing at the main
 *  document's URL keeps relative font/icon URLs resolvable from `about:blank`.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'

const OBSERVED_ATTRIBUTES = ['class', 'style', 'lang', 'dir', 'data-theme']
const OBSERVED_ROOT_ATTRIBUTES = [
  'class',
  'style',
  'lang',
  'dir',
  ...OBSERVED_ATTRIBUTES,
  'data-theme',
]

function copyAttributes(source: Element, target: Element, names?: readonly string[]): void {
  for (const attr of Array.from(source.attributes)) {
    if (names && !names.includes(attr.name)) continue
    if (target.getAttribute(attr.name) !== attr.value) {
      target.setAttribute(attr.name, attr.value)
    }
  }
  if (names) {
    for (const attr of Array.from(target.attributes)) {
      if (names.includes(attr.name) && !source.hasAttribute(attr.name)) {
        target.removeAttribute(attr.name)
      }
    }
  }
}

function mirrorStyleElement(source: HTMLElement, target: HTMLElement): void {
  if (target.textContent !== source.textContent) target.textContent = source.textContent
  if (
    source.hasAttribute('media') &&
    target.getAttribute('media') !== source.getAttribute('media')
  ) {
    target.setAttribute('media', source.getAttribute('media') ?? '')
  }
}

function copyHeadNode(source: Node, targetDoc: Document): Element | null {
  if (source.nodeType !== Node.ELEMENT_NODE) return null
  const element = source as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'style') {
    const clone = targetDoc.createElement('style')
    clone.dataset['mirroredStyle'] = element.dataset['mirroredStyle'] ?? ''
    mirrorStyleElement(element, clone)
    return clone
  }
  if (tag === 'link') {
    const clone = targetDoc.createElement('link')
    const rel = element.getAttribute('rel') ?? ''
    clone.setAttribute('rel', rel)
    for (const attr of ['media', 'type', 'crossorigin', 'integrity']) {
      const value = element.getAttribute(attr)
      if (value !== null) clone.setAttribute(attr, value)
    }
    const href = element.getAttribute('href')
    // `about:blank` resolves relative URLs against itself, which does not exist
    // as a resource; the main document's base is the correct origin.
    if (href) clone.setAttribute('href', new URL(href, sourceDoc(element).baseURI).href)
    return clone
  }
  return null
}

function sourceDoc(node: Node): Document {
  return node.ownerDocument ?? document
}

function collectMirroredNodes(doc: Document): Element[] {
  return Array.from(doc.head.children).filter((el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'style') return true
    return tag === 'link' && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') ?? '')
  })
}

/**
 * Prepare `targetDoc` so it can host a React portal with the workbench styles.
 * Returns a disposable that stops the one-way observers.
 *
 * The caller owns `targetDoc`'s lifecycle; this only creates/updates nodes.
 */
export function mirrorDocumentChrome(mainDoc: Document, targetDoc: Document): IDisposable {
  const targetHead = targetDoc.head
  const targetRoot = targetDoc.documentElement
  const targetBody = targetDoc.body

  if (!targetHead.querySelector('base')) {
    const base = targetDoc.createElement('base')
    base.setAttribute('href', mainDoc.baseURI)
    targetHead.prepend(base)
  }
  if (!targetHead.querySelector('meta[charset]')) {
    const charset = targetDoc.createElement('meta')
    charset.setAttribute('charset', 'UTF-8')
    targetHead.prepend(charset)
  }

  const styleNodes = new Map<Element, Element>()
  const syncStyles = (): void => {
    const wanted = collectMirroredNodes(mainDoc)
    const wantedSet = new Set(wanted)
    for (const [source, clone] of styleNodes) {
      if (!wantedSet.has(source) || !clone.isConnected) {
        clone.remove()
        styleNodes.delete(source)
      }
    }
    for (const source of wanted) {
      let clone = styleNodes.get(source)
      if (!clone || !clone.isConnected) {
        const created = copyHeadNode(source, targetDoc)
        if (!created) continue
        targetHead.appendChild(created)
        clone = created
        styleNodes.set(source, clone)
      }
      if (source.tagName.toLowerCase() === 'style') {
        mirrorStyleElement(source as HTMLElement, clone as HTMLElement)
      } else if (source.tagName.toLowerCase() === 'link') {
        const href = source.getAttribute('href')
        if (href) {
          const resolved = new URL(href, mainDoc.baseURI).href
          if ((clone as HTMLLinkElement).href !== resolved) clone.setAttribute('href', resolved)
        }
      }
    }
  }

  const syncChrome = (): void => {
    copyAttributes(mainDoc.documentElement, targetRoot, OBSERVED_ROOT_ATTRIBUTES)
    copyAttributes(mainDoc.body, targetBody, OBSERVED_ATTRIBUTES)
    // 刻意不镜像 document.title：每个窗口有自己的原生标题（活动编辑器 +
    // "Editor Window"，见 AuxiliaryTitleBar）；复制主标题会让 Alt+Tab 条目重名。
  }

  syncStyles()
  syncChrome()

  // Main -> auxiliary only (never observe the child), so there is no feedback
  // loop. Watching the whole head subtree keeps lazily injected/HMR styles and
  // theme CSS text updates flowing after mount.
  const headObserver = new MutationObserver(syncStyles)
  headObserver.observe(mainDoc.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'media', 'rel'],
  })
  const chromeObserver = new MutationObserver(syncChrome)
  chromeObserver.observe(mainDoc.documentElement, {
    attributes: true,
    attributeFilter: OBSERVED_ROOT_ATTRIBUTES,
  })
  chromeObserver.observe(mainDoc.body, {
    attributes: true,
    attributeFilter: OBSERVED_ATTRIBUTES,
  })

  return toDisposable(() => {
    headObserver.disconnect()
    chromeObserver.disconnect()
  })
}

/** Create the React host (`#root`) inside the auxiliary document. */
export function ensureAuxiliaryRoot(targetDoc: Document): HTMLElement {
  let root = targetDoc.getElementById('root')
  if (!root) {
    root = targetDoc.createElement('div')
    root.id = 'root'
    targetDoc.body.appendChild(root)
  }
  if (!targetDoc.getElementById('auxiliary-window-layout')) {
    // about:blank has no UA margins/height chain; the editor grid fills the viewport.
    const layout = targetDoc.createElement('style')
    layout.id = 'auxiliary-window-layout'
    layout.textContent = `html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}`
    targetDoc.head.appendChild(layout)
  }
  return root
}
