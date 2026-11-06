import type { Niche } from '../../../shared/niche'
import './style-sections.css'

/** The niche as rows: label, then what it says. Shared by this section and the chat's draft. */
export function NicheList({ niche }: { niche: Niche }) {
  return (
    <dl className="nl" data-testid="niche">
      <div>
        <dt>For</dt>
        <dd data-testid="niche-who">{niche.who}</dd>
      </div>
      <div>
        <dt>They get</dt>
        <dd>{niche.promise}</dd>
      </div>
      <div>
        <dt>Reels to make</dt>
        <dd>
          <ul>
            {niche.angles.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </dd>
      </div>
      {niche.avoid.length > 0 && (
        <div>
          <dt>Words to avoid</dt>
          <dd className="nl-avoid">{niche.avoid.join(' · ')}</dd>
        </div>
      )}
    </dl>
  )
}
