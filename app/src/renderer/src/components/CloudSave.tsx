// The iCloud Drive / Google Drive way in "Send to my phone". With a drive app on this computer, one click copies
// the video (not the caption) into a Reel Studio folder on the drive; without one, the drive websites, for
// uploading by hand. Either way it says where the video turns up on the phone.
import { useEffect, useState, type ReactNode } from 'react'
import type { CloudDrive } from '../../../shared/api'
import { driveNames } from '../../../shared/cloud-drive-names'
import { reel, userMessage } from '../api'
import { FOLDER_APP, Spinner } from './ui'

const ICLOUD_URL = 'https://www.icloud.com/iclouddrive/'
const GDRIVE_URL = 'https://drive.google.com/drive/my-drive'

const ON_PHONE: Record<CloudDrive['label'], string> = {
  'iCloud Drive': 'On your iPhone, open the Files app, then iCloud Drive › Reel Studio.',
  'Google Drive': 'On your phone, open the Drive app and find the Reel Studio folder.'
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; drive: CloudDrive; name: string }
  | { kind: 'saved'; drive: CloudDrive; name: string; path: string }
  | { kind: 'error'; message: string }

export function CloudSave({ video, icon }: { video: string; icon: ReactNode }) {
  const [drives, setDrives] = useState<CloudDrive[] | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  useEffect(() => {
    let live = true
    reel.cloud.drives().then(
      (found) => live && setDrives(found),
      () => live && setDrives([])
    )
    return () => {
      live = false
    }
  }, [])

  const names = drives ? driveNames(drives) : []
  const save = async (drive: CloudDrive, name: string) => {
    setState({ kind: 'saving', drive, name })
    try {
      const path = await reel.cloud.save(video, drive.folder)
      setState({ kind: 'saved', drive, name, path })
    } catch (error) {
      setState({ kind: 'error', message: userMessage(error) })
    }
  }

  const buttons = drives?.length ? drives : null
  return (
    <div className="phone-way" data-testid="phone-cloud">
      {icon}
      <div>
        <b>Put it in iCloud Drive or Google Drive</b>
        {drives && (
          <p className="muted-sm">
            {buttons
              ? 'Saves a copy of the video in a Reel Studio folder on your drive. Then open it on your phone and save it from there.'
              : 'Upload the video at icloud.com/iclouddrive or drive.google.com (the buttons open them). Then open the Files app (iPhone) or Drive app (Android) on your phone and save it from there.'}
          </p>
        )}
        {buttons && (
          <div className="row wrap cloud-buttons">
            {buttons.map((drive, i) => (
              // aria-disabled, not disabled: a disabled button drops keyboard focus to the page mid-save.
              <button
                className="btn small"
                key={drive.folder}
                aria-disabled={state.kind === 'saving'}
                onClick={() => state.kind !== 'saving' && void save(drive, names[i])}
              >
                {state.kind === 'saving' && state.drive.folder === drive.folder && <Spinner />}
                <span>Save to {names[i]}</span>
              </button>
            ))}
          </div>
        )}
        <div role="status" data-testid="cloud-status">
          {state.kind === 'saving' && <p className="muted-sm cloud-saving">Saving to {state.name}…</p>}
          {state.kind === 'saved' && (
            <div className="cloud-saved">
              <p>
                <b>Saved to {state.name}.</b> It shows up on your phone once your drive finishes syncing.
              </p>
              <p>{ON_PHONE[state.drive.label]}</p>
              <button className="link left" onClick={() => void reel.app.openFolder(state.path)}>
                Show in {FOLDER_APP}
              </button>
            </div>
          )}
        </div>
        {state.kind === 'error' && (
          <p role="alert" className="phone-note cloud-error">
            {state.message}
          </p>
        )}
      </div>
      {drives && !buttons && (
        <div className="stack" style={{ gap: 6 }}>
          <a className="btn small" href={ICLOUD_URL} target="_blank" rel="noreferrer" data-testid="phone-icloud">
            iCloud Drive
          </a>
          <a className="btn small" href={GDRIVE_URL} target="_blank" rel="noreferrer" data-testid="phone-gdrive">
            Google Drive
          </a>
        </div>
      )}
    </div>
  )
}
