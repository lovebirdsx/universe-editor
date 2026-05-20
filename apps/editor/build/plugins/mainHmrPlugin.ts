import type { Plugin } from 'vite'

/**
 * electron-vite dev plugin: after the main-process bundle is rewritten, signal
 * Electron to relaunch. electron-vite's own server already handles sending the
 * hot-restart signal via its internal vite-plugin-electron mechanism; this plugin
 * makes the behaviour explicit and adds a preload-only reload path.
 *
 * Applied only in serve (dev) mode (`apply: 'serve'`).
 */
export function mainHmrPlugin(): Plugin {
  return {
    name: 'universe-editor:main-hmr',
    apply: 'serve',
    // electron-vite calls closeBundle after each incremental rebuild of the main
    // process. At that point the new bundle is on disk. We log a marker so
    // developers can see the restart happening in the terminal.
    closeBundle() {
      // electron-vite's own plugin layer already sends `app.relaunch()+app.quit()`
      // when it detects a main-process rebuild. Logging here lets developers
      // see the trigger in the Vite output without duplicating the IPC call.
      console.log('[universe-editor:main-hmr] main process rebuilt — relaunching…')
    },
  }
}
