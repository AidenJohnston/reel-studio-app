// Library › Videos: the footage folders and drives Reel Studio reads where they are (main/footage-sources.ts), and the
// index reading them (main/footage-index.ts). The person sees which folders are added, which drive is unplugged,
// and what the index is reading now; Remove is the way back out and deletes nothing on disk.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FootageIndexStatus, FootageSource } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Button, IconButton, Progress } from './ui'
import { Icon } from './icons'
import './footage.css'

/** "12 videos", or what the person should know about a folder the index hasn't read or can't reach. */
export function folderLine(s: FootageSource): string {
  if (!s.online) return s.files ? `Not plugged in. Its ${s.files === 1 ? 'video comes' : `${s.files} videos come`} back when it is.` : 'Not plugged in.'
  if (s.files === null) return 'Waiting to be read'
  if (s.files === 0) return 'No videos in it yet. New ones are read as they arrive.'
  return s.files === 1 ? '1 video' : `${s.files} videos`
}

/** `say`: the Library's one result line (Library.tsx), for an error or what a removal did. */
export function FootageFolders({ say }: { say: (r: { text: string; error?: boolean }) => void }) {
  const [sources, setSources] = useState<FootageSource[] | null>(null)
  const [status, setStatus] = useState<FootageIndexStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const was = useRef<FootageIndexStatus['state']>('idle')

  const load = useCallback(() => reel.footage.sources().then(setSources, (e) => say({ text: userMessage(e), error: true })), [say])
  useEffect(() => void load(), [load])

  // The index reports through status alone; reading it once a second while this tab shows costs one IPC call.
  // A run that finished brings new counts, and a drive plugged in or out shows on the next poll of the list.
  useEffect(() => {
    let n = 0
    const tick = () => {
      void reel.footage.status().then((s) => {
        if (was.current === 'indexing' && s.state !== 'indexing') void load()
        was.current = s.state
        setStatus(s)
      })
      if (++n % 5 === 0) void load()
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [load])

  const run = async (work: () => Promise<FootageSource[]>, done?: string) => {
    setBusy(true)
    try {
      setSources(await work())
      if (done) say({ text: done })
    } catch (e) {
      say({ text: userMessage(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const reading = status.state === 'indexing'
  return (
    <section className="lib-group footage" aria-labelledby="footage-h" data-testid="footage-folders">
      <div className="footage-head">
        <h2 id="footage-h">
          Footage folders {sources && sources.length > 0 && <span className="n">{sources.length}</span>}
        </h2>
        <Button kind="secondary" size="small" disabled={busy} onClick={() => void run(() => reel.footage.addSource())} data-testid="footage-add">
          <Icon name="plus" size={14} /> Add a folder
        </Button>
      </div>
      <p className="footage-about">
        A folder or drive of your videos. Reel Studio reads it where it is, once, so your editor can find any moment in it. Nothing is copied until a clip is used.
      </p>
      {(reading || status.state === 'error') && (
        <div className="footage-status" role="status" data-testid="footage-index">
          {reading ? (
            <>
              <span>{status.message}</span>
              <Progress pct={status.pct} label="Reading your videos" />
            </>
          ) : (
            <span className="error">{status.message}</span>
          )}
        </div>
      )}
      {sources && sources.length > 0 && (
        <ul className="lib-rows footage-rows">
          {sources.map((s) => (
            <li key={s.id} className={`footage-row${s.online ? '' : ' away'}`} data-testid="footage-folder">
              <Icon name="folder" size={16} />
              <span className="lib-row-t" title={s.path}>
                <b>{s.name}</b>
                <span>{folderLine(s)}</span>
              </span>
              <IconButton icon="x" label={`Remove ${s.name}`} disabled={busy} onClick={() => void run(() => reel.footage.removeSource(s.id), `Removed ${s.name}. Its videos stay where they are.`)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
