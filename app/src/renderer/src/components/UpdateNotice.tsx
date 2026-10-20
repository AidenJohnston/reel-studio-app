// "Reel Studio 0.1.1 is out." A quiet card at the bottom of the sidebar: never a dialog, never takes
// focus, so it cannot get in the way of an export. Main decides what to show (main/update-check.ts).
import { useEffect, useState } from 'react'
import type { UpdateNotice as Notice } from '../../../shared/api'
import { reel } from '../api'
import { useNotify } from '../App'

export function UpdateNotice() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const notify = useNotify()

  useEffect(() => {
    let live = true
    reel.update
      .status()
      .then((s) => live && setNotice(s.notice))
      .catch(() => {})
    const off = reel.update.onChange((n) => setNotice(n))
    return () => {
      live = false
      off()
    }
  }, [])

  if (!notice) return null
  return (
    <div className="update-card" role="status" data-testid="update-notice">
      <div className="update-text">Reel Studio {notice.version} is out.</div>
      <div className="update-sub">Download opens the page in your browser.</div>
      <div className="update-actions">
        <button
          className="btn small primary"
          onClick={() => reel.update.open(notice.url).catch(() => notify('I could not open the download page. Try again in a moment.', 'error'))}
          data-testid="update-download"
        >
          Download
        </button>
        <button
          className="link inline"
          onClick={() => {
            setNotice(null)
            void reel.update.dismiss(notice.version).catch(() => {})
          }}
          data-testid="update-later"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
