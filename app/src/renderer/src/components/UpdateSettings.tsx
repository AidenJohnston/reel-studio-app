// Settings > About: where this copy stands and the one button for it (T3 Code's Settings "About" row:
// Download / Downloading… / Install / Up to Date / Checking…). Same state and actions as the sidebar button.
import { RELEASES_URL } from '../../../shared/config'
import { settingsUpdateRow } from '../../../shared/update'
import { Icon } from './icons'
import { Progress } from './ui'
import { useUpdateActions, useUpdateState } from './update'

export function UpdateSettingsRow() {
  const s = useUpdateState()
  const { act, pending, dialog } = useUpdateActions()
  if (!s) return null
  const row = settingsUpdateRow(s)
  return (
    <div className="update-row" data-testid="update-settings">
      <div className="update-row-line">
        <p className="muted-sm" data-testid="update-settings-text">
          {row.text}
        </p>
        {/* Always there (as on 0.1.2), so "download from GitHub" is never a dead end. Opens in the browser
            through the window's open handler (main/index.ts). */}
        <a className="update-releases-link" href={RELEASES_URL} target="_blank" rel="noreferrer" data-testid="update-releases-link">
          Releases page <Icon name="external" size={12} stroke={2} />
        </a>
        {row.button && (
          <button className="btn small" disabled={row.disabled || pending} onClick={() => void act(s)} data-testid="update-settings-button">
            {row.button}
          </button>
        )}
      </div>
      {s.status === 'downloading' && <Progress pct={s.downloadPercent ?? 0} label="Downloading the update" />}
      {/* Screen readers hear each stage once; the percentage stays in the progress bar. */}
      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : row.text}
      </span>
      {dialog}
    </div>
  )
}
