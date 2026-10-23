import { RELEASES_URL } from '../../../shared/config'
import { updateAction } from '../../../shared/update'
import { updateSummary } from './update-copy'
import { Icon } from './icons'
import { Progress } from './ui'
import { useUpdateActions, useUpdateState } from './update'

export function UpdateSettingsRow() {
  const s = useUpdateState()
  const { act, pending, dialog } = useUpdateActions()
  if (!s) return null
  const action = updateAction(s)
  const disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(s.status)
  const text = s.status === 'idle' ? `You have Reel Studio ${s.currentVersion}.` : updateSummary(s).replace(/ Click to .*$/, '')
  const button = action !== 'none' ? (s.status === 'error' ? 'Try again' : action === 'install' ? 'Restart to update' : 'Download')
    : s.status === 'checking' ? 'Checking…' : s.status === 'downloading' ? 'Downloading…' : s.status === 'installing' ? 'Restarting…'
    : s.status === 'up-to-date' ? 'Check again' : s.status === 'error' ? 'Try again' : 'Check for updates'
  return (
    <div className="update-row" data-testid="update-settings">
      <div className="update-row-line">
        <p className="muted-sm" data-testid="update-settings-text">
          {text}
        </p>

        <a className="update-releases-link" href={RELEASES_URL} target="_blank" rel="noreferrer" data-testid="update-releases-link">
          Releases page <Icon name="external" size={12} stroke={2} />
        </a>
        {s.status !== 'disabled' && (
          <button className="btn small" disabled={disabled || pending} onClick={() => void act(s)} data-testid="update-settings-button">
            {button}
          </button>
        )}
      </div>
      {s.status === 'downloading' && <Progress pct={s.downloadPercent ?? 0} label="Downloading the update" />}

      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : text}
      </span>
      {dialog}
    </div>
  )
}
