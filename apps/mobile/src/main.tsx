import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { registerServiceWorker } from './pwa.js'
import { initTheme } from './theme.js'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('mobile: #root element is missing')

initTheme()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()
