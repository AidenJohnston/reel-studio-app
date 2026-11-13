// The pictures of what the AI just changed, shown under a note's progress while the draft is still
// being made (shared/live.ts `moments`): stills of the changed moments, then the 2 s around them.
import type { Moment } from '../../../shared/live'
import { clock } from '../../../shared/progress'

export function MomentStrip({ moments }: { moments: Moment[] }) {
  return (
    <div className="moment-strip" data-testid="note-moments">
      {moments.map((m) =>
        m.kind === 'still' ? (
          <img key={m.image} className="moment" src={m.image} alt={`Your change at ${clock(m.t)}`} draggable={false} />
        ) : (
          <video key={m.video} className="moment" src={m.video} muted autoPlay loop playsInline
            aria-label={`Your change, ${clock(m.from)} to ${clock(m.to)}`} />
        )
      )}
    </div>
  )
}
