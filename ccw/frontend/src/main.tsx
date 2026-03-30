import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import 'xterm/css/xterm.css'
import { loadMessagesForLocale, getInitialLocale } from './lib/i18n'
import { logWebVitals } from './lib/webVitals'
import { initializeAuth } from './lib/api'

async function bootstrapApplication() {
  const rootElement = document.getElementById('root')
  if (!rootElement) throw new Error('Failed to find the root element')

  // Acquire auth cookie before rendering — required for remote access (--host 0.0.0.0).
  // On localhost, auth middleware bypasses public paths so this is harmless.
  await initializeAuth()

  const locale = await getInitialLocale()

  // Load only the active locale's messages (lazy load secondary on demand)
  const messages = await loadMessagesForLocale(locale)

  const root = createRoot(rootElement)
  root.render(
    <StrictMode>
      <App locale={locale} messages={messages} />
    </StrictMode>
  )

  // Initialize Web Vitals monitoring (LCP, FID, CLS)
  // Logs metrics to console in development; extend to analytics in production
  logWebVitals()
}

bootstrapApplication().catch((error) => {
  console.error('Failed to bootstrap application:', error)
})
