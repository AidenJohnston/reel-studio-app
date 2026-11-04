import { useEffect, useState } from 'react'
import type { StyleRule } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'

export function MyStyle() {
  const notify = useNotify()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [damaged, setDamaged] = useState(false)
  const load = () => Promise.all([reel.style.rules().then(setRules), reel.style.damaged().then(setDamaged)])
  useEffect(() => {
    void load()
  }, [])
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>My style</h1>
          <p className="muted">Things you told me to always do. I use them on every video.</p>
        </div>
      </div>
      {damaged && (
        <div className="banner" role="status" style={{ marginBottom: 16 }} data-testid="style-damaged">
          Your saved style file was damaged, so I started a new one. The old one is kept next to it.
        </div>
      )}
      {rules && rules.length === 0 && (
        <div className="panel">
          <p>Nothing here yet.</p>
          <p className="muted" style={{ marginTop: 6 }}>
            When you write a note like "always use big subtitles", I'll remember it here.
          </p>
        </div>
      )}
      <div className="list">
        {rules?.map((r) => (
          <div key={r.id} className="list-item">
            <span style={{ fontSize: 16 }}>{r.text}</span>
            <span className="spacer" />
            <button
              className="btn small ghost danger"
              onClick={async () => {
                try {
                  await reel.style.remove(r.id)
                  await load()
                } catch (e) {
                  notify(userMessage(e), 'error')
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
