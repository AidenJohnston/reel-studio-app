import { useEffect, useState } from 'react'
import type { CloudDrive } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { FOLDER_APP, Spinner } from './ui'

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; drive: CloudDrive }
  | { kind: 'saved'; drive: CloudDrive; path: string }
  | { kind: 'error'; message: string }

export function CloudSave({ video, fallback = false }: { video: string; fallback?: boolean }) {
  const [drives, setDrives] = useState<CloudDrive[]>([])
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  useEffect(() => {
    let live = true
    void reel.cloud.drives().then((drives) => { if (live) setDrives(drives) }).catch(() => {})
    return () => { live = false }
  }, [])

  if (!drives.length) return null
  const label = (drive: CloudDrive) => {
    if (drives.filter((other) => other.label === drive.label).length === 1) return drive.label
    const account = drive.folder.match(/GoogleDrive-([^/\\]+)/)?.[1] ?? drive.folder
    return `${drive.label} · ${account}`
  }
  const save = async (drive: CloudDrive) => {
    setState({ kind: 'saving', drive })
    try {
      const path = await reel.cloud.save(video, drive.folder)
      setState({ kind: 'saved', drive, path })
    } catch (error) {
      setState({ kind: 'error', message: userMessage(error) })
    }
  }
  const actions = (
    <div className="stack cloud-save" style={{ gap: 8 }} data-testid="cloud-save">
      <div className="stack" style={{ gap: 8 }}>
        {drives.map((drive) => (
          <button className="btn small" key={drive.folder} title={`Save to ${label(drive)}`} disabled={state.kind === 'saving'} onClick={() => void save(drive)}>
            {state.kind === 'saving' && state.drive.folder === drive.folder && <Spinner />} <span>Save to {label(drive)}</span>
          </button>
        ))}
      </div>
      <div role="status" className="muted-sm">
        {state.kind === 'saving' && `Saving to ${label(state.drive)}…`}
        {state.kind === 'saved' && (
          <div className="row wrap">
            <span>Saved to {label(state.drive)}</span>
            <button className="btn small" onClick={() => void reel.app.openFolder(state.path)}>Show in {FOLDER_APP}</button>
          </div>
        )}
      </div>
      {state.kind === 'error' && <p role="alert" className="phone-note">{state.message}</p>}
    </div>
  )
  return fallback ? <div className="phone-way"><Icon name="folder" /><div>{actions}</div></div> : actions
}
