import type { AppInfo, DataSharing } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { SettingRow, Switch, useShown } from './settings-rows'
import type { SettingId } from './settings-index'

/**
 * The checker's job with Settings › Editor › "Double-check each edit" on (ai editor.ts checkAndRepair), worded the same
 * on that switch and on the checker's model row, so the two don't describe one role two ways (audit-1028 finding 16).
 */
export const CHECKS_NOTE = 'Checks each new version against your note'

const PARTS: [keyof Omit<DataSharing, 'asked' | 'on'>, SettingId, string][] = [
  ['usage', 'sharing-usage', 'Which features you use, and errors.'],
  ['quality', 'sharing-quality', 'A score for each edit: kept, changed or undone.'],
  ['posts', 'sharing-posts', 'View counts of reels you’ve posted. Nothing else.']
]

export const NEVER_SHARED = 'Never your videos, words, notes or file names.'

/** Settings › Privacy: one switch for sharing, then what to share. Only the choice is saved; nothing is sent. */
export function Privacy({ info, onInfo, onError }: { info: AppInfo; onInfo: (i: AppInfo) => void; onError: (m: string) => void }) {
  const s = info.sharing
  const master = useShown('sharing')
  const set = async (patch: Partial<DataSharing>) => {
    try {
      onInfo(await reel.app.setSharing({ ...s, asked: true, ...patch }))
    } catch (e) {
      onError(userMessage(e))
    }
  }
  return (
    <div className={`privacy${s.on ? '' : ' off'}`} data-testid="privacy">
      <SettingRow
        id="sharing"
        line={
          <span className="never">
            <Icon name="lock" size={14} />
            {NEVER_SHARED}
          </span>
        }
        control={<Switch on={s.on} labelledBy="set-sharing" onToggle={() => void set({ on: !s.on })} testid="share-on" />}
      />
      {PARTS.map(([k, id, line]) => (
        <SettingRow key={k} id={id} sub line={line} control={<Switch on={s.on && s[k]} disabled={!s.on} labelledBy={`set-${id}`} onToggle={() => void set({ [k]: !s[k] })} testid={`share-${k}`} />} />
      ))}
      {master && <p className="srow-foot">{s.on ? 'Nothing is sent yet. When it is, it goes with no account or name attached.' : 'Nothing is shared. Turn this on to choose what to share.'}</p>}
    </div>
  )
}
