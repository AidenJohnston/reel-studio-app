// The phone companion page's entry (renderer/companion.html), served by the desktop over the home network
// (main/companion/server.ts). It runs in an ordinary browser: window.reel doesn't exist here, so nothing this page
// imports may call it.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import './companion.css'
import { Companion } from './Companion'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Companion />
  </StrictMode>
)
