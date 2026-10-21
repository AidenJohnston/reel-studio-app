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

      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : row.text}
      </span>
      {dialog}
    </div>
  )
}
