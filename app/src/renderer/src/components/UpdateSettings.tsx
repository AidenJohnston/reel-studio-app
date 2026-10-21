// Settings > About: where this copy stands and the one button for it (T3 Code's Settings "About" row:
// Download / Downloading… / Install / Up to Date / Checking…). Same state and actions as the sidebar button.
import { settingsUpdateRow } from '../../../shared/update'
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
