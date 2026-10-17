import { useEffect, useState } from 'react'
import type { ProjectSummary } from '../../../shared/api'
import { niceDate, reel } from '../api'
import type { Go } from '../nav'
import { Icon } from '../components/icons'

const STATUS: Record<ProjectSummary['status'], string> = {
  new: 'Getting started',
  working: 'Working on it',
  ready: 'Ready',
  interrupted: 'Paused',
  failed: 'Did not finish'
}

/** "My very long video title from Tuesday" -> "My very long vid…om Tuesday": keeps the start and the end. */
function middle(title: string, max = 34): string {
  if (title.length <= max) return title
  const head = Math.ceil((max - 1) * 0.6)
  return `${title.slice(0, head).trimEnd()}…${title.slice(title.length - (max - 1 - head)).trimStart()}`
}

export function Home({ go }: { go: Go }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)

  useEffect(() => {
    let live = true
    const load = () => reel.projects.list().then((p) => live && setProjects(p))
    void load()
    const off = reel.jobs.onEvent((e) => {
      if (e.type !== 'status') void load()
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const open = (p: ProjectSummary) => {
    if (p.status === 'ready') go({ name: 'reel', slug: p.slug })
    else go({ name: 'working', slug: p.slug })
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Your videos</h1>
          <p className="muted">Drop in a raw video and I'll turn it into a reel.</p>
        </div>
        <button className="btn primary big" onClick={() => go({ name: 'new' })} data-testid="new-video">
          <Icon name="plus" /> New video
        </button>
      </div>

      {projects && projects.length === 0 && (
        <div className="drop tall">
          <div className="drop-icon">
            <Icon name="video" size={28} />
          </div>
          <h2>Make your first reel</h2>
          <p className="muted">Drag your video anywhere onto this window, or click New video.</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="grid">
          {projects.map((p) => (
            <button key={p.slug} className="card" onClick={() => open(p)} data-testid="project-card" title={p.title}>
              <div className="thumb">
                {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <Icon name="video" size={34} className="placeholder" />}
              </div>
              <div className="card-body">
                <div className="card-title">{middle(p.title)}</div>
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <span className={`badge ${p.status}`} data-testid="card-status">
                    {p.status === 'ready' && p.version ? `Ready · Version ${p.version}` : STATUS[p.status]}
                  </span>
                </div>
                <div className="muted-sm" style={{ marginTop: 6 }}>{niceDate(p.updatedAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
