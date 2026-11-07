import { useEffect, useId, useState } from 'react'
import { MERGE_LAYERS, type MergeLayer, type MergeRequest, type QueuedNote, type VersionInfo } from '../../../shared/api'
import { versionGraph, type GraphRow } from '../../../shared/version-graph'
import { LAYER_WORDS, mergeWords } from '../../../shared/combine'
import { ago } from '../../../shared/memory'
import { Button, Modal, Segmented } from './ui'
import { reel, userMessage } from '../api'
import './version-tree.css'

const ROW = 48
const LANE = 14
const laneX = (i: number): number => 9 + i * LANE

/** The lines and dot of one row: lines from the row above meet the dot, lines below lead to its parents. */
function Lanes({ row }: { row: GraphRow }) {
  const mid = ROW / 2
  const x = laneX(row.lane)
  const through = row.above.filter((i) => !row.into.includes(i) && row.below.includes(i))
  return (
    <svg className="vt-lanes" width={laneX(row.width - 1) + 9} height={ROW} aria-hidden>
      {through.map((i) => (
        <line key={`t${i}`} x1={laneX(i)} y1={0} x2={laneX(i)} y2={ROW} />
      ))}
      {row.into.map((i) => (
        <path key={`i${i}`} d={i === row.lane ? `M${x} 0V${mid}` : `M${laneX(i)} 0C${laneX(i)} ${mid / 2} ${x} ${mid / 2} ${x} ${mid}`} />
      ))}
      {row.from.map((i) => (
        <path key={`f${i}`} d={i === row.lane ? `M${x} ${mid}V${ROW}` : `M${x} ${mid}C${x} ${mid * 1.5} ${laneX(i)} ${mid * 1.5} ${laneX(i)} ${ROW}`} />
      ))}
      <circle cx={x} cy={mid} r={4.5} />
    </svg>
  )
}

/** "from Version 2", or "from Versions 3 and 5" for a combined one; nothing for the usual one-after-the-other. */
function fromWords(v: VersionInfo): string | null {
  if (v.parents) return `from Versions ${v.parents[0]} and ${v.parents[1]}`
  return v.parent !== null && v.parent !== v.n - 1 ? `from Version ${v.parent}` : null
}

/**
 * Versions > the reel's versions as a tree, newest first: which one each was made from, the one on screen marked.
 * Change this one makes the next note change that version (its result is a new branch from it); Combine makes a new
 * version from parts of two.
 */
export function VersionTree({
  versions,
  queue,
  shown,
  nameOf,
  busy,
  base,
  onPlay,
  onChange,
  onCombine
}: {
  versions: VersionInfo[]
  /** notes not saved yet: each shows where its version will hang, dashed, until it is made */
  queue: QueuedNote[]
  shown: number | null
  nameOf: (v: VersionInfo) => string
  /** a job runs on the reel: Combine waits for it (a note can still be written and waits its turn) */
  busy: boolean
  /** the version the next note changes, when one was chosen */
  base: number | null
  onPlay: (n: number) => void
  onChange: (n: number) => void
  onCombine: (n: number) => void
}) {
  // Notes run in turn, each from its own version. A note for the newest builds on the one before it in line.
  const latest = versions[versions.length - 1]?.n ?? 0
  const ghosts = new Map<number, { q: QueuedNote; from: number }>()
  let head = latest
  for (const q of queue.filter((x) => !x.hand)) {
    const n = latest + ghosts.size + 1
    const from = q.branch ?? head
    if (q.branch === undefined) head = n
    ghosts.set(n, { q, from })
  }
  const rows = versionGraph([...versions, ...[...ghosts].map(([n, g]) => ({ n, parent: g.from }))])
  const byN = new Map(versions.map((v) => [v.n, v]))
  const now = Date.now()
  const fromNumber = (n: number): string => (ghosts.has(n) ? 'the one before it' : `Version ${n}`)
  return (
    <ol className="vt" aria-label="Versions of this reel" data-testid="version-tree">
      {rows.map((row) => {
        const ghost = ghosts.get(row.n)
        if (ghost) {
          const running = !!ghost.q.attempt
          return (
            <li key={`g${ghost.q.id}`} className={`vt-row ghost${running ? ' now' : ''}`} data-testid="vt-ghost">
              <Lanes row={row} />
              <span className="vt-main">
                <span className="vt-l1">
                  <b>New version</b>
                  <span className="vt-name">{ghost.q.text}</span>
                </span>
                <span className="vt-l2">
                  {running ? `Making it from ${fromNumber(ghost.from)}` : `Waits its turn · from ${fromNumber(ghost.from)}`}
                </span>
              </span>
            </li>
          )
        }
        const v = byN.get(row.n)!
        const name = nameOf(v)
        const from = fromWords(v)
        const when = ago(v.createdAt, now)
        return (
          <li key={row.n} className={`vt-row${shown === row.n ? ' on' : ''}${base === row.n ? ' base' : ''}`} aria-current={shown === row.n || undefined} data-testid={`vt-${row.n}`}>
            <Lanes row={row} />
            <button className="vt-main" onClick={() => onPlay(row.n)} aria-label={`Play Version ${row.n}${name ? `, ${name}` : ''}`} data-testid={`vt-play-${row.n}`}>
              <span className="vt-l1">
                <b>Version {row.n}</b>
                {name && <span className="vt-name">{name}</span>}
              </span>
              <span className="vt-l2">{[from, when].filter(Boolean).join(' · ')}</span>
            </button>
            <span className="vt-acts">
              <button className="lk" onClick={() => onChange(row.n)} aria-label={`Change Version ${row.n} with your next note`} data-testid={`vt-change-${row.n}`}>
                Change this one
              </button>
              {versions.length > 1 && (
                <button className="lk" onClick={() => onCombine(row.n)} data-testid={`vt-combine-${row.n}`}>
                  Combine…
                </button>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Combine: a new version that starts from `ours` and takes the parts the person picks from another. Only the parts
 * that differ are asked about. */
export function CombineDialog({ slug, versions, ours, busy, onClose, onStarted }: { slug: string; versions: VersionInfo[]; ours: number; busy: boolean; onClose: () => void; onStarted: (jobId: string) => void }) {
  const titleId = useId()
  const others = versions.filter((v) => v.n !== ours).map((v) => v.n)
  // the one most likely meant: the newest other version
  const [theirs, setTheirs] = useState(others[others.length - 1])
  const [differ, setDiffer] = useState<MergeLayer[] | null>(null)
  const [take, setTake] = useState<MergeRequest['take']>(() => Object.fromEntries(MERGE_LAYERS.map((l) => [l, 'ours'])) as MergeRequest['take'])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    let live = true
    setDiffer(null)
    setError(null)
    setTake(Object.fromEntries(MERGE_LAYERS.map((l) => [l, 'ours'])) as MergeRequest['take'])
    reel.projects
      .mergeLayers(slug, ours, theirs)
      .then((l) => live && setDiffer(l))
      .catch((e) => live && setError(userMessage(e)))
    return () => {
      live = false
    }
  }, [slug, ours, theirs])
  const request: MergeRequest = { ours, theirs, take }
  const picked = MERGE_LAYERS.some((l) => take[l] === 'theirs')
  const same = differ ? MERGE_LAYERS.filter((l) => !differ.includes(l)) : []
  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      onStarted((await reel.projects.mergeVersions(slug, request)).jobId)
    } catch (e) {
      setError(userMessage(e))
      setStarting(false)
    }
  }
  return (
    <Modal onClose={onClose} testid="combine" labelledBy={titleId}>
      <h2 id={titleId}>Combine two versions</h2>
      <p className="muted">
        A new version starts from Version {ours}. Pick the parts to take from the other one instead.
      </p>
      <label className="cb-with">
        <span>Take parts from</span>
        <select className="input" value={theirs} onChange={(e) => setTheirs(Number(e.target.value))} data-testid="combine-theirs">
          {others.map((n) => (
            <option key={n} value={n}>
              Version {n}
            </option>
          ))}
        </select>
      </label>
      {differ === null && !error ? (
        <p className="muted" aria-busy data-testid="combine-reading">
          Comparing the two…
        </p>
      ) : differ && differ.length === 0 ? (
        <p className="muted" data-testid="combine-same">
          Version {ours} and Version {theirs} are the same in every part, so there is nothing to combine.
        </p>
      ) : (
        <ul className="cb-parts" aria-label="Where each part comes from">
          {(differ ?? []).map((l) => (
            <li key={l} className="cb-part">
              <span>{LAYER_WORDS[l]}</span>
              <Segmented
                label={LAYER_WORDS[l]}
                value={take[l]}
                options={[
                  { key: 'ours', label: `Version ${ours}` },
                  { key: 'theirs', label: `Version ${theirs}` }
                ]}
                onPick={(k) => setTake((t) => ({ ...t, [l]: k }))}
                testid={`combine-${l}`}
              />
            </li>
          ))}
        </ul>
      )}
      {same.length > 0 && differ && differ.length > 0 && (
        <p className="muted cb-same" data-testid="combine-unchanged">
          The same in both: {same.map((l) => LAYER_WORDS[l].toLowerCase().replace(/^the /, '')).join(', ')}.
        </p>
      )}
      {/* says why Make is off until a part is picked: the button's title alone was missed (Sense re-score 4) */}
      {!picked && !busy && differ && differ.length > 0 && (
        <p className="muted" data-testid="combine-pick">
          Pick at least one part from Version {theirs} to make the new version.
        </p>
      )}
      {busy && (
        <p className="muted" data-testid="combine-busy">
          You can make it once the version being made now is finished.
        </p>
      )}
      {error && (
        <p className="cin-alert" role="alert" data-testid="combine-error">
          {error}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="tertiary" onClick={onClose} data-testid="combine-cancel">
          Cancel
        </Button>
        <Button kind="primary" disabled={!picked || starting || busy || differ === null} title={picked ? mergeWords(request) : `Pick at least one part from Version ${theirs}`} onClick={() => void start()} data-testid="combine-make">
          Make the new version
        </Button>
      </div>
    </Modal>
  )
}
