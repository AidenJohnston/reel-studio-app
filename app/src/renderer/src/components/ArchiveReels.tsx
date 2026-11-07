// Library › Videos › Reels in your footage (main/archive-reels.ts): the editor reads what was said across all the
// read footage and suggests reels, each from one to three files; the person ticks the ones to make. The look can be
// stopped, and making a reel copies only its files. Same rows and ticks as More reels (ReelsFound.tsx).
import { useCallback, useEffect, useState } from 'react'
import type { ArchiveStatus } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Button } from './ui'
import { Icon } from './icons'
import './plan.css'
import './reels-found.css'
import './footage.css'

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const fileName = (ref: string): string => ref.split('/').pop() ?? ref

/** "a.mp4 0:05 to 0:20 · b.mp4 0:02 to 0:07": which parts of which files a reel is cut from. */
export function spansLine(spans: ArchiveStatus['candidates'][number]['spans']): string {
  return spans.map((s) => `${fileName(s.ref)} ${clock(s.t0)} to ${clock(s.t1)}`).join(' · ')
}

export function ArchiveReels({ say }: { say: (r: { text: string; error?: boolean } | null) => void }) {
  const [st, setSt] = useState<ArchiveStatus | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => reel.footage.reels().then(setSt, (e) => say({ text: userMessage(e), error: true })), [say])
  useEffect(() => void load(), [load])
  // while the editor reads, its words and the result arrive by asking once a second
  const finding = st?.state === 'finding'
  useEffect(() => {
    if (!finding) return
    const id = window.setInterval(() => void load(), 1000)
    return () => window.clearInterval(id)
  }, [finding, load])

  const find = async () => {
    say(null)
    try {
      await reel.footage.findReels()
      setPicked([])
      await load()
    } catch (e) {
      say({ text: userMessage(e), error: true })
    }
  }
  const make = async () => {
    setBusy(true)
    say(null)
    try {
      const { made } = await reel.footage.makeReels(picked)
      setPicked([])
      say({ text: made.length === 1 ? 'Making 1 reel. It is on Reels.' : `Making ${made.length} reels. They are on Reels.` })
      await load()
    } catch (e) {
      say({ text: userMessage(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const list = st?.candidates ?? []
  return (
    <section className="lib-group footage" aria-labelledby="archive-h" data-testid="archive-reels">
      <div className="footage-head">
        <h2 id="archive-h">Reels in your footage</h2>
        {finding ? (
          <Button kind="tertiary" size="small" onClick={() => st?.jobId && void reel.jobs.cancel(st.jobId).then(load)} data-testid="archive-stop">
            Stop
          </Button>
        ) : (
          <Button kind="secondary" size="small" onClick={() => void find()} data-testid="archive-find">
            {list.length ? 'Look again' : 'Find reels'}
          </Button>
        )}
      </div>
      <p className="footage-about">Your editor reads what you said across all your read footage and suggests reels, each from one to three of your videos.</p>
      {(finding || st?.state === 'error') && (
        <div className="footage-status" role="status" data-testid="archive-status">
          <span className={finding ? undefined : 'error'}>{st?.message}</span>
        </div>
      )}
      {!finding && st?.at && !list.length && (
        <p className="footage-about" data-testid="archive-none">
          {st.notes || "Your editor didn't find a reel that stands on its own in your footage."}
        </p>
      )}
      {list.length > 0 && (
        <>
          <ul className="lib-rows footage-rows" data-testid="archive-list">
            {list.map((c) => {
              const id = `ar-${c.id}`
              return (
                <li key={c.id} className={`archive-row${c.made ? ' made' : ''}`} data-testid="archive-row">
                  {c.made ? (
                    <Icon name="check" size={16} />
                  ) : (
                    <label className="pl-tick">
                      <input
                        id={id}
                        type="checkbox"
                        checked={picked.includes(c.id)}
                        disabled={busy || finding}
                        onChange={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                        data-testid="archive-tick"
                      />
                      <span aria-hidden>{picked.includes(c.id) ? <Icon name="check" size={11} stroke={2.6} /> : null}</span>
                    </label>
                  )}
                  <span className="lib-row-t">
                    {c.made ? <b>{c.title}</b> : <label htmlFor={id}><b>{c.title}</b></label>}
                    <span>{c.why}</span>
                    <span data-testid="archive-spans">
                      {spansLine(c.spans)} · {Math.round(c.seconds)} s{c.made ? ' · Made' : ''}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
          {st?.truncated && <p className="footage-about">Your editor read part of your footage: there was more than one look can read.</p>}
          <div className="archive-actions">
            <Button kind="secondary" size="small" disabled={!picked.length || busy || finding} onClick={() => void make()} data-testid="archive-make">
              {picked.length > 1 ? `Make ${picked.length} reels` : 'Make this reel'}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
