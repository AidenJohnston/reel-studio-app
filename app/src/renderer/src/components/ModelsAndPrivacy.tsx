import { useEffect, useRef, useState } from 'react'
import type { AppInfo, DataSharing, JobKind, UsageLine } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { Button } from './ui'
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
      {s.on ? <Kept sharing={s} onError={onError} /> : <Sample sharing={s} />}
      {master && (
        <p className="srow-foot">
          {s.on
            ? 'Nothing is sent: this version of Reel Studio has nowhere to send it yet. When it does, it goes with no account or name attached.'
            : 'Nothing is kept or shared. Turn this on to choose what to share.'}
        </p>
      )}
    </div>
  )
}

const JOB_WORDS: Record<JobKind, string> = { 'first-edit': 'First edit', note: 'Note', rerender: 'New version', export: 'Export', script: 'Plan', propose: 'Reel ideas', plan: 'Picture plan' }
const OUTCOME_WORDS = { done: 'finished', failed: 'failed', cancelled: 'stopped' } as const
const PLATFORM_WORDS = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' } as const

/** One waiting event in plain words: everything it holds except the fields every line carries (shown once, below). */
export function usageWords(l: UsageLine): string {
  if (l.name === 'job') return `${JOB_WORDS[l.job]} ${OUTCOME_WORDS[l.outcome]}${l.code ? ` (${l.code})` : ''}, ${l.seconds} s`
  if (l.name === 'edit') return `An edit was ${l.outcome}`
  return `${PLATFORM_WORDS[l.platform]}: ${l.views.toLocaleString()} views after ${l.hours} h`
}

/** One made-up line of each part, so the person can see what a line holds before turning sharing on. */
const SAMPLES: Record<keyof Omit<DataSharing, 'asked' | 'on'>, UsageLine> = {
  usage: { part: 'usage', name: 'job', job: 'note', outcome: 'done', seconds: 42, day: '', app: '', os: '', install: '' },
  quality: { part: 'quality', name: 'edit', outcome: 'kept', day: '', app: '', os: '', install: '' },
  posts: { part: 'posts', name: 'views', platform: 'instagram', views: 1204, hours: 72, day: '', app: '', os: '', install: '' }
}

/** Sharing off: what a line would look like for each part chosen, and that nothing is kept until it is on. */
function Sample({ sharing }: { sharing: DataSharing }) {
  const parts = (Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]).filter((k) => sharing[k])
  return (
    <SettingRow id="sharing-sample" sub line={parts.length ? 'Nothing is kept while sharing is off. With it on, lines like these:' : 'Choose at least one kind of data above.'}>
      {parts.length > 0 && (
        <div className="srow-more">
          <ol className="usage-lines" data-testid="usage-sample">
            {parts.map((k) => <li key={k}>{usageWords(SAMPLES[k])}</li>)}
          </ol>
          <p className="srow-foot">Each also carries the day, Reel Studio’s version, your system and a random number made when you turn sharing on.</p>
        </div>
      )}
    </SettingRow>
  )
}

/**
 * What sharing has kept on this computer, line by line (main/usage.ts). There is no server for it yet, so this is
 * everything there is; turning sharing off deletes it.
 */
function Kept({ sharing, onError }: { sharing: DataSharing; onError: (m: string) => void }) {
  const [lines, setLines] = useState<UsageLine[] | null>(null)
  const [open, setOpen] = useState(false)
  const report = useRef(onError)
  report.current = onError
  useEffect(() => {
    let live = true
    reel.app.usage().then((l) => live && setLines(l), (e) => live && report.current(userMessage(e)))
    return () => {
      live = false
    }
    // a part switched off drops its lines: read again after each change
  }, [sharing])
  const n = lines?.length ?? 0
  return (
    <SettingRow
      id="sharing-kept"
      sub
      line={lines === null ? 'Reading…' : n ? `${n} ${n === 1 ? 'event' : 'events'} waiting. None has been sent.` : 'Nothing yet.'}
      control={
        n > 0 && (
          <Button size="small" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="usage-lines" data-testid="usage-show">
            {open ? 'Hide' : 'Show'}
          </Button>
        )
      }
    >
      {open && lines && n > 0 && (
        <div className="srow-more" id="usage-lines">
          <ol className={`usage-lines${n > 8 ? ' long' : ''}`} data-testid="usage-lines">
            {lines
              .slice()
              .reverse()
              .map((l, i) => (
                <li key={n - i}>
                  <span>{l.day}</span> {usageWords(l)}
                </li>
              ))}
          </ol>
          <p className="srow-foot">
            Each also carries Reel Studio’s version ({lines[0].app}), your system ({lines[0].os}) and a random number made when you turned
            sharing on. Turning sharing off deletes all of it.
          </p>
        </div>
      )}
    </SettingRow>
  )
}
