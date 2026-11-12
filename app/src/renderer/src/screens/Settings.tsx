import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppInfo, EngineCache, LegalDoc, PermissionStatus } from '../../../shared/api'
import { sizeLine } from '../../../shared/size'
import { channelOf, productName } from '../../../shared/channel'
import { reel, userMessage } from '../api'
import type { Go, SettingsSection } from '../nav'
import { ConnectAI, DevProviders, downloadLine, useModelStatus } from '../components/connect'
import { usePermissionStatus } from '../components/permissions'
import { Button, Confirm, FOLDER_APP, IS_MAC, Progress, Spinner } from '../components/ui'
import { Icon } from '../components/icons'
import { useUpdateState } from '../components/update'
import { AutoUpdatesControl, autoUpdatesLine, LegalText, UpdateSettingsRow, useUpdateKey, WhatsNew } from '../components/UpdateSettings'
import { useNotify } from '../App'
import { CHECKS_NOTE, Privacy } from '../components/ModelsAndPrivacy'
import { NoteRunnerRow, OutsideAppsRow } from '../components/AiApps'
import { EasyAiRow } from '../components/AiSetup'
import { TitleBarSlot } from '../components/titlebar'
import { findSettings, SECTIONS, SETTING_IDS, SETTINGS, type SectionId, type SettingId } from '../components/settings-index'
import { Marked, SearchHits, SearchScope, SettingRow, Switch, useShown } from '../components/settings-rows'
import '../components/settings.css'
import { StockKeys } from '../components/stock-keys'
import { PostingRows } from '../components/PostingSettings'
import { SocialRows } from '../components/SocialSettings'
import { DevicesRows } from '../components/Devices'

/** Where the older section names (nav.ts) land now: a section, or one row of it. */
const TARGET: Record<SettingsSection, SectionId | SettingId> = { ai: 'editor', listen: 'listening-model', where: 'library-folder', notify: 'notifications', privacy: 'privacy', posting: 'posting', about: 'about' }
const sectionOf = (t: SectionId | SettingId): SectionId => (t in SECTIONS ? (t as SectionId) : SETTINGS[t as SettingId].section)

export function Settings({ info, onInfo, section }: { info: AppInfo; onInfo: (i: AppInfo) => void; go?: Go; section?: SettingsSection }) {
  const notify = useNotify()
  // The nightly reads and writes the stable app's speech model folder (main/paths.ts modelsDir)
  const sharedModel = channelOf(info.version) === 'nightly'
  const [query, setQuery] = useState('')
  const hits = useMemo(() => findSettings(query), [query])
  const search = useRef<HTMLInputElement>(null)
  const [current, setCurrent] = useState<SectionId>(sectionOf(TARGET[section ?? 'ai']))
  const lock = useRef(0)
  const page = useRef<HTMLDivElement>(null)

  // The list of sections marks the one being read, so a long page never loses its place.
  useEffect(() => {
    if (hits) return
    const root = page.current?.closest('.main') ?? null
    const seen = new Map<Element, boolean>()
    const blocks = Array.from(page.current?.querySelectorAll('.ssec') ?? [])
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => seen.set(e.target, e.isIntersecting))
        const top = blocks.find((b) => seen.get(b))
        if (top && performance.now() > lock.current) setCurrent(top.id.replace('sec-', '') as SectionId)
      },
      { root, rootMargin: '0px 0px -60% 0px' }
    )
    blocks.forEach((b) => io.observe(b))
    return () => io.disconnect()
  }, [hits])

  useEffect(() => {
    const t = section && section !== 'ai' ? TARGET[section] : null
    if (t) (t in SECTIONS ? document.getElementById(`sec-${t}`) : document.querySelector(`[data-setting="${t}"]`))?.scrollIntoView({ block: 'start' })
    search.current?.focus({ preventScroll: true })
  }, [section])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const goTo = (k: SectionId) => {
    lock.current = performance.now() + 1000
    setCurrent(k)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('kb')
    document.getElementById(`sec-${k}`)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }
  const clear = () => {
    setQuery('')
    search.current?.focus()
  }
  const shown = (id: SettingId): boolean => !hits || hits.has(id)
  const sections = (Object.keys(SECTIONS) as SectionId[]).filter((k) => !hits || SETTING_IDS.some((id) => SETTINGS[id].section === k && hits.has(id)))

  const update = useUpdateState()
  const updateKey = useUpdateKey()
  const [legal, setLegal] = useState<LegalDoc | null>(null)
  const [savingExports, setSavingExports] = useState(false)
  // The switch moves when pressed (#146), goes back if saving fails, and stays disabled until the save is done:
  // while a video job keeps main busy, its answer can take a while.
  const [fasterExports, setFasterExports] = useState(info.fasterExports)
  useEffect(() => setFasterExports(info.fasterExports), [info.fasterExports])
  // Double-check each edit (main/settings.ts checkEdits): off by default, read once like the other switches
  const [checkEdits, setCheckEdits] = useState<boolean | null>(null)
  const [savingChecks, setSavingChecks] = useState(false)
  useEffect(() => {
    reel.ai.checkEdits().then(setCheckEdits).catch(() => {})
  }, [])
  // Look things up in parallel (main/settings.ts lookUps): off by default, like Double-check
  const [lookUps, setLookUps] = useState<boolean | null>(null)
  const [savingLookUps, setSavingLookUps] = useState(false)
  useEffect(() => {
    reel.ai.lookUps().then(setLookUps).catch(() => {})
  }, [])
  const toggleLookUps = async () => {
    if (lookUps === null) return
    setSavingLookUps(true)
    try {
      setLookUps(await reel.ai.setLookUps(!lookUps))
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setSavingLookUps(false)
    }
  }
  const toggleCheckEdits = async () => {
    if (checkEdits === null) return
    setSavingChecks(true)
    try {
      setCheckEdits(await reel.ai.setCheckEdits(!checkEdits))
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setSavingChecks(false)
    }
  }
  const toggleExports = async () => {
    const on = !fasterExports
    setFasterExports(on)
    setSavingExports(true)
    try {
      onInfo(await reel.app.setFasterExports(on))
    } catch (e) {
      setFasterExports(!on)
      notify(userMessage(e), 'error')
    } finally {
      setSavingExports(false)
    }
  }
  const toggleUpdates = async (on: boolean) => {
    try {
      await reel.update.setEnabled(on)
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  // Re-checked while Settings is open, so a change made in System Settings shows here.
  const { status: perm, apply } = usePermissionStatus()
  // What a request that is still out asked for. "asking" can also mean macOS never answered; the switch stays usable.
  const [pending, setPending] = useState<'folder' | { notifications: boolean } | null>(null)
  const request = async (what: NonNullable<typeof pending>, fn: () => Promise<PermissionStatus>) => {
    setPending(what)
    try {
      apply(await fn())
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setPending(null)
    }
  }
  const toggleAlerts = (on: boolean) => request({ notifications: on }, () => reel.perm.setNotifications(on))
  const alerts = perm?.notifications
  const alertsOn = pending && pending !== 'folder' ? pending.notifications : alerts !== 'off'
  const isMac = info.platform === 'darwin'

  const change = async () => {
    const p = await reel.app.chooseFolder()
    if (!p) return
    try {
      onInfo(await reel.app.setRoot(p))
      notify('New reels are kept there. Reels you already made stay where they are.')
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  return (
    <div className="page settings-page" ref={page}>
      <TitleBarSlot title="Settings" />
      <div className="settings">
        <nav className="snav" aria-label="Settings sections">
          {sections.map((k) => (
            <button key={k} aria-current={!hits && current === k} onClick={() => goTo(k)} data-testid={`settings-nav-${k}`}>
              {SECTIONS[k]}
            </button>
          ))}
        </nav>
        <div className="sbody">
          <div className="ssearch" role="search">
            <Icon name="search" size={16} stroke={1.75} />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              aria-keyshortcuts={IS_MAC ? 'Meta+F' : 'Control+F'}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }}
              data-testid="settings-search"
            />
            {query && (
              <button className="icon-btn ssearch-x" aria-label="Clear search" onClick={clear}>
                <Icon name="x" size={14} stroke={2} />
              </button>
            )}
          </div>
          <p className="sr-only" role="status">
            {hits ? (hits.size === 1 ? '1 setting matches' : hits.size ? `${hits.size} settings match` : 'No settings match') : ''}
          </p>

          <SearchScope hits={hits} query={query}>
            {hits?.size === 0 && (
              <div className="snone" data-testid="settings-no-match">
                <p>No settings match “{query.trim()}”.</p>
                <Button size="small" onClick={clear}>
                  Clear search
                </Button>
              </div>
            )}

            <Section id="editor" desc="It picks your best takes, adds pictures and makes the changes in your notes.">
              {/* hidden, not unmounted: a search must not drop a check or sign-in that is under way. The same component
                  as the first run's editor step: CLIProxyAPI, Claude Code, the Codex app, Advanced, and the editor in use
                  with its accounts, limits, Test and a model for each stage. */}
              <div className="srow picker-row" data-setting="editor" hidden={!(['editor', 'models', 'own-server', 'api-key'] as const).some(shown)}>
                <ConnectAI stagesOpen />
              </div>
              {checkEdits !== null && (
                <SettingRow
                  id="check-edits"
                  line={`${CHECKS_NOTE} before you see it, and your editor fixes what the check finds. Notes take longer and use more of your AI plan.`}
                  control={<Switch on={checkEdits} disabled={savingChecks} labelledBy="set-check-edits" onToggle={() => void toggleCheckEdits()} testid="check-edits" />}
                />
              )}
              {lookUps !== null && (
                <SettingRow
                  id="look-ups"
                  line="When a note needs pictures of several things, Reel Studio asks a second AI to find them at the same time as your editor: your Claude Code app or Codex app, whichever your editor is not, if it is signed in, or else your editor again. It only looks things up, never changes your video, and uses more of your AI plan."
                  control={<Switch on={lookUps} disabled={savingLookUps} labelledBy="set-look-ups" onToggle={() => void toggleLookUps()} testid="look-ups" />}
                />
              )}
              <NoteRunnerRow onError={(m) => notify(m, 'error')} />
              <OutsideAppsRow onError={(m) => notify(m, 'error')} />
            </Section>

            <Section id="privacy">
              <Privacy info={info} onInfo={onInfo} onError={(m) => notify(m, 'error')} />
            </Section>

            <Section id="reels">
              <SettingRow
                id="library-folder"
                line="New reels are saved here."
                control={
                  <Button size="small" onClick={() => void change()}>
                    Change…
                  </Button>
                }
              >
                <PathLine path={info.root} display={info.rootDisplay} testid="root-display" />
                {perm && perm.folder !== 'allowed' && (
                  <div className="srow-more row">
                    <p className="pv-note error" role="alert" data-testid="folder-problem">
                      {perm.folder === 'unusable'
                        ? "Reel Studio can't save in this folder. Choose another one."
                        : perm.folder === 'denied'
                          ? "Your Mac isn't letting Reel Studio use this folder. Press Allow to turn it on in System Settings."
                          : 'Press Allow so Reel Studio can use this folder.'}
                    </p>
                    {(perm.folder === 'denied' || perm.folder === 'not-asked') && (
                      <Button size="small" disabled={pending === 'folder'} onClick={() => void request('folder', () => reel.perm.allowFolder())} data-testid="folder-allow">
                        Allow
                      </Button>
                    )}
                  </div>
                )}
              </SettingRow>
              <ListeningModel shared={sharedModel} />
              <SettingRow
                id="faster-exports"
                line="New reels finish at 30 fps, which is quicker, with less smooth motion. Leave it off to keep smooth phone footage smooth. Previews while you edit are quick either way."
                control={<Switch on={fasterExports} disabled={savingExports} labelledBy="set-faster-exports" onToggle={() => void toggleExports()} testid="faster-exports" />}
              />
              {alerts === undefined || alerts === 'unsupported' ? (
                <SettingRow id="notifications" line="This computer doesn't show notifications from Reel Studio." />
              ) : (
                <SettingRow
                  id="notifications"
                  line={
                    <span data-testid="notifications-note">
                      {alerts === 'asking'
                        ? 'Your Mac asks in the top-right corner of the screen. Choose Allow.'
                        : alerts === 'blocked'
                          ? 'Notifications are off for Reel Studio on this computer. Turn them on in your system settings, then press Try again.'
                          : alerts === 'unverified' && isMac
                            ? "Your Mac decides whether they show. If you don't see them, turn them on in System Settings."
                            : 'One notification per reel, so you can do other things while it’s made.'}
                    </span>
                  }
                  control={
                    <Switch on={alertsOn} disabled={pending !== null && pending !== 'folder'} labelledBy="set-notifications" onToggle={() => void toggleAlerts(!alertsOn)} testid="notifications-toggle" />
                  }
                >
                  {alerts !== 'off' && (isMac || alerts === 'asking' || alerts === 'blocked') && (
                    <div className="srow-more row">
                      {isMac && (
                        <Button size="small" onClick={() => void reel.perm.openSettings('notifications')} data-testid="notifications-settings">
                          Open System Settings
                        </Button>
                      )}
                      {alerts === 'asking' && pending === null && (
                        <Button size="small" kind="tertiary" onClick={() => void toggleAlerts(true)}>
                          Ask again
                        </Button>
                      )}
                      {alerts === 'blocked' && (
                        <Button size="small" kind="tertiary" onClick={() => void toggleAlerts(true)}>
                          Try again
                        </Button>
                      )}
                    </div>
                  )}
                </SettingRow>
              )}
            </Section>

            <Section id="posting">
              <PostingRows />
              <SocialRows />
            </Section>

            <Section id="devices" desc="Your reels stay on this computer. A paired phone or browser reaches them over your Wi-Fi; no account is needed.">
              <DevicesRows />
            </Section>
            <Section id="about">
              <SettingRow id="version" line={`${productName(info.version)} ${info.version}. No account needed.${info.engine.mode === 'fake' ? ' Test engine in use.' : ''}`} />
              <SettingRow
                id="licence"
                line="Open source under the GNU AGPL v3, with no warranty. The parts it's built on keep their own licences."
                control={
                  <span className="sctl">
                    <button className="ext-link" onClick={() => setLegal('license')} data-testid="licence-link">
                      Licence
                    </button>
                    <button className="ext-link" onClick={() => setLegal('notices')} data-testid="notices-link">
                      Notices
                    </button>
                  </span>
                }
              />
              <SettingRow
                id="updates"
                line="Once a day, Reel Studio asks getreelstudio.com for a newer version. Nothing about you or your reels is sent."
                control={update !== null && <Switch on={update.autoCheck} labelledBy="set-updates" onToggle={() => void toggleUpdates(!update.autoCheck)} testid="check-updates" />}
              >
                <UpdateSettingsRow />
              </SettingRow>
              {updateKey && update?.status !== 'disabled' && (
                <SettingRow id="auto-updates" line={autoUpdatesLine(updateKey)} control={<AutoUpdatesControl status={updateKey} />} />
              )}
              <SettingRow id="whats-new">
                <WhatsNew />
              </SettingRow>
              {legal && <LegalText doc={legal} onClose={() => setLegal(null)} />}
            </Section>

            <Section id="advanced">
              {/* the keys let your editor search for pictures; they are not editors (audit-1028 finding 16) */}
              <Subhead ids={['stock-keys']}>Stock photos and footage</Subhead>
              <StockKeys />
              <Subhead ids={['easy-ai']}>Being tested</Subhead>
              <EasyAiRow onError={(m) => notify(m, 'error')} />
              <Subhead ids={['engine-cache', 'logs', 'first-run']}>Troubleshooting</Subhead>
              <CacheRow shared={sharedModel} onError={(m) => notify(m, 'error')} />
              <SettingRow
                id="logs"
                line="What Reel Studio did and any errors, for when something goes wrong."
                control={
                  <button className="btn small" onClick={() => void reel.app.showLogs().catch((e) => notify(userMessage(e), 'error'))} data-testid="show-logs">
                    Show logs
                  </button>
                }
              />
              <FirstRunRow info={info} shared={sharedModel} onInfo={onInfo} onError={(m) => notify(m, 'error')} />
            </Section>

            {info.dev && !hits && (
              <section className="ssec" id="sec-dev">
                <h2>Developer: AI provider</h2>
                <p className="ssec-desc">Shown because REELSTUDIO_DEV=1.</p>
                <DevProviders />
              </section>
            )}
          </SearchScope>
        </div>
      </div>
    </div>
  )
}

/** A heading and its rows. A search that finds none of them hides the whole section, keeping its rows' state. */
function Section({ id, desc, children }: { id: SectionId; desc?: string; children: ReactNode }) {
  const hits = useContext(SearchHits)
  return (
    <section
      className="ssec"
      id={`sec-${id}`}
      aria-labelledby={`sec-${id}-h`}
      hidden={!!hits && !SETTING_IDS.some((s) => SETTINGS[s].section === id && hits.has(s))}
      data-testid={`settings-${id}`}
    >
      <h2 id={`sec-${id}-h`}>
        <Marked text={SECTIONS[id]} />
      </h2>
      {desc && !hits && <p className="ssec-desc">{desc}</p>}
      <div className="srows">{children}</div>
    </section>
  )
}

/** The on-device model that writes down what you say. */
function ListeningModel({ shared }: { shared: boolean }) {
  const { s } = useModelStatus()
  const line = `Writes down what you say, on this computer, for subtitles and your notes. ${shared ? 'About 500 MB, shared with Reel Studio on this computer.' : 'About 500 MB, once.'}`
  if (!s) return <SettingRow id="listening-model" line={line} control={<Spinner />} />
  const paused = !s.installed && !s.downloading && s.pct > 0 && s.pct < 100
  return (
    <SettingRow
      id="listening-model"
      line={line}
      control={
        s.installed ? (
          <span className="sval ok" data-testid="model-ready">
            <Icon name="check" size={14} stroke={2.4} />
            Ready
          </span>
        ) : s.checking ? (
          <span className="sval">Checking…</span>
        ) : s.downloading ? (
          <Button size="small" kind="tertiary" onClick={() => void reel.model.cancel()} data-testid="pause-model">
            Pause
          </Button>
        ) : (
          <Button size="small" onClick={() => void reel.model.download()} data-testid="download-model">
            {paused ? 'Keep downloading' : 'Download'}
          </Button>
        )
      }
    >
      {(s.downloading || paused || s.checking) && (
        <div className="srow-more">
          <Progress pct={s.pct} label={s.checking ? 'Checking the listening model' : 'Downloading the listening model'} />
          {!s.checking && (
            <span className="muted-sm" data-testid="model-progress">
              {downloadLine(s, s.downloading ? 'Downloading' : 'Paused at')}
            </span>
          )}
        </div>
      )}
      {s.error && (
        <p className="pv-note error" role="alert" data-testid="model-error">
          {s.error}
        </p>
      )}
      {s.installed && s.checkFailed && (
        <p className="muted-sm srow-more" data-testid="model-check-failed">
          Reel Studio couldn't work out the fastest settings for this computer, so the listening model uses its usual ones. Everything still works.
        </p>
      )}
    </SettingRow>
  )
}

/** A heading inside a section, shown while any of its rows is. */
function Subhead({ ids, children }: { ids: SettingId[]; children: ReactNode }) {
  const hits = useContext(SearchHits)
  if (hits && !ids.some((id) => hits.has(id))) return null
  return <h3 className="ssub">{children}</h3>
}

/** A folder on this computer: small and muted, never the row's headline, with the way to open it. */
function PathLine({ path, display, testid }: { path: string; display: string; testid: string }) {
  return (
    <div className="spath">
      <span title={path} data-testid={testid}>
        <bdi dir="ltr">{display}</bdi>
      </span>
      <button className="btn small ghost" onClick={() => void reel.app.openFolder(path)}>
        Show in {FOLDER_APP}
      </button>
    </div>
  )
}

/** The engine's cache: its size, where it is, and Clear cache behind a confirm. */
function CacheRow({ shared, onError }: { shared: boolean; onError: (m: string) => void }) {
  const [cache, setCache] = useState<EngineCache | null>(null)
  const [asking, setAsking] = useState(false)
  const [clearing, setClearing] = useState(false)
  const shown = useShown('engine-cache')
  const failed = useRef(onError)
  failed.current = onError
  // measured each time the row comes into view, so a search for "cache" shows the size as it is now
  useEffect(() => {
    if (!shown) return
    let live = true
    reel.app
      .engineCache()
      .then((c) => live && setCache(c))
      .catch((e) => live && failed.current(userMessage(e)))
    return () => {
      live = false
    }
  }, [shown])
  const clear = async () => {
    setAsking(false)
    setClearing(true)
    try {
      setCache(await reel.app.clearEngineCache())
      // Clear cache is disabled once there's nothing to clear; focus stays in the row instead of falling to the page
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-setting="engine-cache"] .spath button')?.focus())
    } catch (e) {
      onError(userMessage(e))
    } finally {
      setClearing(false)
    }
  }
  const empty = cache?.bytes === 0
  return (
    <SettingRow
      id="engine-cache"
      line="Song analysis and picture lookups kept so the next reel is quicker. Clearing it is safe."
      control={
        <span className="sctl">
          <span className="sval" data-testid="cache-size">
            {cache ? sizeLine(cache.bytes) : <Spinner />}
          </span>
          <button className="btn small" disabled={!cache || empty} aria-busy={clearing} onClick={() => !clearing && setAsking(true)} data-testid="clear-cache">
            {clearing && <Spinner />} Clear cache
          </button>
        </span>
      }
    >
      {cache && <PathLine path={cache.path} display={cache.pathDisplay} testid="cache-path" />}
      {asking && cache && (
        <Confirm
          title="Clear the cache?"
          body={`This deletes ${sizeLine(cache.bytes)} of saved song analysis and picture lookups. Your reels, Library and settings stay${shared ? ', and so does the listening model you share with Reel Studio' : ''}. The next reel may take a little longer.`}
          yes="Clear cache"
          no="Cancel"
          danger
          onYes={() => void clear()}
          onNo={() => setAsking(false)}
        />
      )}
    </SettingRow>
  )
}

/** Reset first run: the welcome and the sample show again the next time the app opens, never in the middle of this run. */
function FirstRunRow({ info, shared, onInfo, onError }: { info: AppInfo; shared: boolean; onInfo: (i: AppInfo) => void; onError: (m: string) => void }) {
  const [asking, setAsking] = useState(false)
  const set = async (on: boolean) => {
    setAsking(false)
    try {
      onInfo(await reel.app.setFirstRunAgain(on))
    } catch (e) {
      onError(userMessage(e))
    }
  }
  return (
    <SettingRow
      id="first-run"
      line={
        <span data-testid="first-run-line">
          {info.firstRunAgain ? `The welcome and the sample show the next time ${productName(info.version)} opens.` : `Shows the welcome and the sample again the next time ${productName(info.version)} opens. Your reels stay.`}
        </span>
      }
      control={
        info.firstRunAgain ? (
          <button className="btn small ghost" onClick={() => void set(false)} data-testid="first-run-undo">
            Undo
          </button>
        ) : (
          <button className="btn small" onClick={() => setAsking(true)} data-testid="reset-first-run">
            Reset…
          </button>
        )
      }
    >
      {asking && (
        <Confirm
          title="Reset the first run?"
          body={`The welcome, the sample and Choose your editor show the next time ${productName(info.version)} opens. Your reels, Library and settings stay${shared ? ', and so does the listening model you share with Reel Studio' : ''}.`}
          yes="Reset first run"
          no="Cancel"
          onYes={() => void set(true)}
          onNo={() => setAsking(false)}
        />
      )}
    </SettingRow>
  )
}
