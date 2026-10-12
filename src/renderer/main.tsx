import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import '@renderer/styles/fonts.css'
import '@renderer/theme/tokens.css'
import '@renderer/styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
