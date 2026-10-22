import { useRef, useState } from 'react'
import type { PlatformExportResult, ProjectJson, VersionInfo } from '../../../shared/api'
import { PLATFORM_RULES, checkPlatform, platformRule, type Platform } from '../../../shared/platforms'
import { reel, userMessage } from '../api'
import { FOLDER_APP, Modal, Spinner } from './ui'
import { SendToPhone } from './SendToPhone'

type ExportState = { kind: 'choosing' } | { kind: 'saving' } | { kind: 'saved'; result: PlatformExportResult }

export function PlatformExportDialog({ slug, version, post, jobId, onClose }: {
  slug: string
  version: VersionInfo
  post: ProjectJson['post']
  jobId?: string
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Platform[]>(['instagram'])
  const [caption, setCaption] = useState(() => [post?.caption ?? '', (post?.hashtags ?? []).map((h) => h.startsWith('#') ? h : `#${h}`).join(' ')].filter(Boolean).join('\n\n'))
  const [seconds, setSeconds] = useState<number | null>(null)
  const [aspectWarning, setAspectWarning] = useState(false)
  const [coverSeconds, setCoverSeconds] = useState(0)
  const [safeChecked, setSafeChecked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ExportState>({ kind: 'choosing' })
  const [phoneFile, setPhoneFile] = useState<PlatformExportResult['files'][number] | null>(null)
  const [copied, setCopied] = useState<Platform | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const toggle = (platform: Platform) => setSelected((current) => current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform])
  const issues = selected.flatMap((platform) => checkPlatform(platform, caption, seconds ?? 0).filter((issue) => issue.blocking).map((issue) => `${platformRule(platform).label}: ${issue.message}`))
  const save = async () => {
    if (!selected.length || !seconds || issues.length || !safeChecked) return
    setError(null)
    setState({ kind: 'saving' })
    try {
      const result = await reel.projects.exportPlatforms(slug, version.n, { platforms: selected, caption, coverSeconds })
      setState({ kind: 'saved', result })
    } catch (e) {
      setError(userMessage(e))
      setState({ kind: 'choosing' })
    }
  }

  if (phoneFile) return <Modal onClose={onClose} wide testid="platform-export-dialog" labelledBy="platform-export-title">
    <h2 id="platform-export-title">Send {platformRule(phoneFile.platform).label} to your phone</h2>
    <SendToPhone video={phoneFile.video} caption={phoneFile.caption} onBack={() => setPhoneFile(null)} />
  </Modal>

  if (state.kind === 'saved') return <Modal key="saved" onClose={onClose} wide testid="platform-export-dialog" labelledBy="platform-export-title">
    <h2 id="platform-export-title" data-testid="export-saved">Saved {state.result.files.length} platform {state.result.files.length === 1 ? 'file' : 'files'}</h2>
    <p className="muted">Your videos, cover frames and post captions are in Library › Finished videos. Upload them in each platform's own app.</p>
    <div className="platform-results">
      {state.result.files.map((file) => <div className="platform-result" key={file.platform}>
        <strong>{platformRule(file.platform).label}</strong>
        <p className="muted-sm selectable" data-testid="export-name">{file.video.split(/[\\/]/).pop()}</p>
        <div className="row wrap">
          <button className="btn small" onClick={() => void reel.app.openFolder(file.video)}>Show in {FOLDER_APP}</button>
          <button className="btn small" onClick={() => setPhoneFile(file)}>Send to my phone</button>
          <button className="btn small" onClick={() => void reel.app.copyText(file.caption).then(() => setCopied(file.platform))}>{copied === file.platform ? 'Copied' : 'Copy caption'}</button>
        </div>
      </div>)}
    </div>
    <button className="btn primary" onClick={onClose} data-autofocus>Done</button>
  </Modal>

  return <Modal onClose={state.kind === 'saving' ? undefined : onClose} wide testid="platform-export-dialog" labelledBy="platform-export-title">
    <h2 id="platform-export-title">Export Version {version.n}</h2>
    <p className="muted">Choose where this video is going. Each platform gets a named video, cover and caption file. Nothing is posted.</p>
    <fieldset className="platform-options" disabled={state.kind === 'saving'}>
      <legend>Platforms</legend>
      {PLATFORM_RULES.map((rule) => <label className="platform-option" key={rule.id}>
        <input type="checkbox" checked={selected.includes(rule.id)} onChange={() => toggle(rule.id)} />
        <span><strong>{rule.label}</strong><small>Up to {rule.maxSeconds >= 60 ? `${rule.maxSeconds / 60} min` : `${rule.maxSeconds} s`}{rule.captionLimit !== null ? ` · caption ${rule.captionLimit}` : ''}</small></span>
      </label>)}
    </fieldset>
    <details className="muted-sm"><summary>Platform details</summary>{PLATFORM_RULES.filter((rule) => selected.includes(rule.id)).map((rule) => <p key={rule.id}>{rule.label}: {rule.width} × {rule.height}. {rule.note ?? 'The caption includes hashtags.'}</p>)}</details>
    <label className="field-label" htmlFor="platform-caption">Post caption and hashtags</label>
    <textarea id="platform-caption" className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={state.kind === 'saving'} />
    <p className="muted-sm">{caption.length} characters. This export caption does not replace your saved post caption.</p>
    <div className="platform-cover">
      <video ref={video} src={version.video} muted controls preload="metadata" onLoadedMetadata={(e) => {
        setSeconds(e.currentTarget.duration)
        setAspectWarning(Math.abs(e.currentTarget.videoWidth / e.currentTarget.videoHeight - 9 / 16) > 0.01)
      }} onError={() => setError('The video could not load. Close this dialog and render the version again.')} />
      <div className="stack">
        <label className="field-label" htmlFor="platform-cover">Cover frame, seconds into the finished video</label>
        <input id="platform-cover" className="input" type="number" min={0} max={Math.max(0, (seconds ?? 0) - 0.05)} step="0.1" value={coverSeconds} disabled={!seconds || state.kind === 'saving'} onChange={(e) => {
          const time = Number(e.target.value)
          if (!Number.isFinite(time) || time < 0 || time >= (seconds ?? 0)) return
          setCoverSeconds(time)
          if (video.current) video.current.currentTime = time
        }} />
        <p className="muted-sm">The cover is a separate JPEG. Select it in the platform's app if that app supports covers.</p>
      </div>
    </div>
    {aspectWarning && <p className="muted-sm">This version is not 9:16. The export adds black bars to fit the full picture in a vertical frame.</p>}
    <label className="platform-option">
      <input type="checkbox" checked={safeChecked} onChange={(e) => setSafeChecked(e.target.checked)} disabled={state.kind === 'saving'} />
      <span>I checked subtitles and important details near the edges.<small>Platform buttons and captions can cover them. Exports fit inside a vertical frame without cropping or moving baked-in text.</small></span>
    </label>
    {seconds !== null && issues.length > 0 && <ul className="platform-errors" role="alert">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    {error && <p className="platform-errors" role="alert">{error}</p>}
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      {state.kind === 'saving'
        ? <button className="btn ghost" disabled={!jobId} onClick={() => jobId && void reel.jobs.cancel(jobId)}>Stop export</button>
        : <button className="btn ghost" onClick={onClose}>Cancel</button>}
      <button className="btn primary" onClick={() => void save()} disabled={state.kind === 'saving' || !selected.length || !seconds || !!issues.length || !safeChecked} data-testid="export-selected">
        {state.kind === 'saving' ? <><Spinner /> Saving files</> : `Export ${selected.length || ''} ${selected.length === 1 ? 'platform' : 'platforms'}`}
      </button>
    </div>
    {version.draft && <p className="muted-sm">This is a preview. I will make the full-quality version before saving the platform files.</p>}
  </Modal>
}
