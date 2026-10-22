import { useCallback, useEffect, useState } from 'react'
import type { LibraryBin } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { FOLDER_APP, PickFiles, Spinner } from '../components/ui'
import { Icon, type IconName } from '../components/icons'
import { describeSorted } from './create'

const ICON: Record<LibraryBin['key'], IconName> = { raw: 'video', broll: 'film', music: 'music', images: 'image', exports: 'done' }
// "B-roll" is jargon: the folder keeps its name, the screen says what it is.
const LABEL: Partial<Record<LibraryBin['key'], string>> = { broll: 'Extra clips' }
const HELP: Record<LibraryBin['key'], string> = {
  raw: 'Videos of you talking.',
  broll: 'Short clips I can show while you talk.',
  music: 'Songs I can put under your voice.',
  images: 'Pictures, logos and screenshots.',
  exports: 'Your finished reels.'
}

function prettySize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n > 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

/** Drops anywhere on the window land here while this screen is open (App handles the drop). */
export function Library({ refreshKey = 0 }: { refreshKey?: number }) {
  const [bins, setBins] = useState<LibraryBin[] | null>(null)
  const [busy, setBusy] = useState(false)
  // What happened to the last files added, said here on the screen (not a toast that follows you).
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null)
  const load = useCallback(() => reel.library.list().then(setBins), [])

  const add = async (paths: string[]) => {
    setBusy(true)
    try {
      const r = await reel.library.add(paths)
      setResult({ text: describeSorted(r) || 'Done.' })
      await load()
    } catch (e) {
      setResult({ text: userMessage(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="muted">Drop anything onto this window. I sort it for you.</p>
        </div>
        <div className="row">
          {busy && <Spinner />}
          <PickFiles className="btn primary" label="Add files" icon={<Icon name="plus" />} onFiles={add} />
        </div>
      </div>
      {result && (
        <div className={`banner${result.error ? ' error' : ' good'}`} role="status" style={{ marginBottom: 22 }} data-testid="library-result">
          <span>{result.text}</span>
          <button className="icon-btn" aria-label="Hide this" onClick={() => setResult(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {!bins && <Spinner />}
      {bins?.map((b) => {
        // Finished videos: one tile per video. Its cover and caption file sit beside it in the folder.
        const files = b.key === 'exports' ? b.files.filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name)) : b.files
        const noun = b.key === 'exports' ? 'video' : 'file'
        return (
          <section key={b.key} className="bin" data-testid={`bin-${b.key}`}>
            <div className="bin-head">
              <h2 className="row" style={{ gap: 8 }}>
                <Icon name={ICON[b.key]} /> {LABEL[b.key] ?? b.label}
              </h2>
              <span className="muted-sm">{files.length ? `${files.length} ${noun}${files.length === 1 ? '' : 's'}` : HELP[b.key]}</span>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => reel.app.openFolder(b.dir)}>
                Show in {FOLDER_APP}
              </button>
            </div>
            {files.length === 0 ? (
              <div className="empty-bin">Nothing here yet.</div>
            ) : (
              <div className="files">
                {files.slice(0, 24).map((f) => (
                  <div key={f.path} className="file" title={f.name}>
                    <div className="file-thumb">
                      {b.key === 'images' ? (
                        <img src={f.url} alt="" loading="lazy" />
                      ) : /\.(mp4|mov|m4v|webm)$/i.test(f.name) ? (
                        <video src={`${f.url}#t=0.5`} preload="metadata" muted disablePictureInPicture />
                      ) : (
                        <Icon name={ICON[b.key]} size={28} />
                      )}
                    </div>
                    <div className="file-name">{f.name}</div>
                    <div className="muted-sm" style={{ padding: '0 10px 8px' }}>{prettySize(f.size)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
