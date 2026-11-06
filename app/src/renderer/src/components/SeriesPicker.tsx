// Reel › More › Series…: the person's fix for automatic grouping (main/series.ts). One choice among the series other
// reels are in, a new one by name, or none. Whatever they pick is kept: grouping never moves this reel again.
import { useEffect, useId, useState } from 'react'
import { reel, userMessage } from '../api'
import { Button, Modal } from './ui'
import '../screens/edit/edit.css'
import './series.css'

const NONE = '\u0000none'
const NEW = '\u0000new'

export function SeriesPicker({ slug, current, onClose, onSaved }: { slug: string; current: string | null; onClose: () => void; onSaved: () => void }) {
  const titleId = useId()
  const [all, setAll] = useState<string[] | null>(null)
  const [pick, setPick] = useState<string>(current ?? NONE)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void reel.projects.list().then((list) => {
      const names = new Set(list.map((p) => p.series).filter((s): s is string => !!s))
      if (current) names.add(current)
      setAll([...names].sort((a, b) => a.localeCompare(b)))
    })
  }, [current])

  const chosen = pick === NONE ? null : pick === NEW ? name.trim() : pick
  const save = async () => {
    if (pick === NEW && !chosen) return setError('Give the new series a name.')
    setSaving(true)
    try {
      await reel.projects.setSeries(slug, chosen)
      onSaved()
    } catch (e) {
      setError(userMessage(e))
      setSaving(false)
    }
  }

  const option = (value: string, label: string) => (
    <label key={value} className={`edit-row radio${pick === value ? ' on' : ''}`}>
      <input type="radio" name="series" checked={pick === value} onChange={() => (setPick(value), setError(null))} />
      <span className="edit-row-main">
        <span className="edit-row-title">{label}</span>
      </span>
    </label>
  )

  return (
    <Modal onClose={onClose} testid="series-picker" labelledBy={titleId}>
      <h2 id={titleId}>Series</h2>
      <p className="muted">Reels that talk about the same thing are grouped on Reels by themselves. Pick another series here, and this reel stays where you put it.</p>
      <div role="radiogroup" aria-labelledby={titleId} className="series-options">
        {all?.map((s) => option(s, s))}
        {option(NEW, 'A new series')}
        {pick === NEW && (
          <input
            className="input"
            autoFocus
            maxLength={80}
            value={name}
            aria-label="Name of the new series"
            placeholder="Name it"
            onChange={(e) => (setName(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            data-testid="series-name"
          />
        )}
        {option(NONE, 'Not in a series')}
      </div>
      {error && (
        <p className="series-error" role="alert">
          {error}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="primary" disabled={saving} onClick={() => void save()} data-testid="series-save">
          Save
        </Button>
      </div>
    </Modal>
  )
}
