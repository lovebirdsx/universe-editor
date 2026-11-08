/* Mobile service worker: shell network-first, static assets cache-first, plus
 * Web Push display and notification-click deep links.
 * Never cache /api/ or /ws — credentials and live frames must not be replayed
 * from a stale cache. */
const CACHE_NAME = 'universe-mobile-v2'
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return

  const isShell =
    request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/pair'

  event.respondWith(isShell ? networkFirst(request) : cacheFirst(request))
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone()).catch(() => undefined)
    return response
  } catch {
    const cached = (await cache.match(request)) ?? (await cache.match('/index.html'))
    return cached ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone()).catch(() => undefined)
  return response
}


/* Web Push ----------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'Universe 遥控'
  const body = typeof payload.body === 'string' ? payload.body : ''
  const url = typeof payload.url === 'string' && payload.url !== '' ? payload.url : '/'
  const tag = typeof payload.tag === 'string' && payload.tag !== '' ? payload.tag : undefined
  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url, kind },
    // iOS ignores actions; staying on screen is the only cross-platform lever.
    requireInteraction: kind === 'permission' || kind === 'question',
  }
  if (tag !== undefined) options.tag = tag
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = typeof data.url === 'string' && data.url !== '' ? data.url : '/'
  event.waitUntil(focusOrOpen(url))
})

async function focusOrOpen(url) {
  const absolute = new URL(url, self.location.origin).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    let origin
    try {
      origin = new URL(client.url).origin
    } catch {
      continue
    }
    if (origin !== self.location.origin) continue
    await client.focus()
    client.postMessage({ type: 'mobile-navigate', url })
    return
  }
  await self.clients.openWindow(absolute)
}
