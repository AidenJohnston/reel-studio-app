import { useEffect, useState } from 'react'
import { SCORE_SCOPE, scoreLine, scoreRows, type EditScore } from '../../../shared/edit-score'
import { reel } from '../api'
import { VersionRows } from './NotesLog'
import './edit-checks.css'

/** A version's edit checks (engine score.py), under its "What changed": read when the row opens. A version the engine
 * can't score (an older one, a damaged folder) shows nothing rather than an error, since nothing about it changed. */
export function EditChecks({ slug, version }: { slug: string; version: number }) {
  const [score, setScore] = useState<EditScore | null>(null)
  useEffect(() => {
    let live = true
    reel.projects.score(slug, version).then(
      (s) => live && setScore(s),
      () => live && setScore(null)
    )
    return () => {
      live = false
    }
  }, [slug, version])
  if (!score || !scoreRows(score).length) return null
  return (
    <div className="echecks" data-testid={`edit-checks-${version}`}>
      <VersionRows
        rows={scoreRows(score)}
        asked={
          <p className="said" title={SCORE_SCOPE}>
            <b>{scoreLine(score)}.</b> {SCORE_SCOPE}
          </p>
        }
      />
    </div>
  )
}
