// "Post to YouTube" (main/posting.ts). Nothing here renders unless posting is turned on (REELSTUDIO_POSTING=1).
import { useEffect, useState } from 'react'
import type { PostingStatus } from '../../../shared/api'
import { reel } from '../api'
import { Icon } from './icons'

/** Posting's status, kept current by main (sign-in, connect, disconnect, a subscription that ended). */
export function usePostingStatus(): [PostingStatus | null, (s: PostingStatus) => void] {
  const [s, setS] = useState<PostingStatus | null>(null)
  useEffect(() => {
    let live = true
    reel.posting
      .status()
      .then((x) => live && setS(x))
      .catch(() => {})
    const off = reel.posting.onChange(setS)
    return () => {
      live = false
      off()
    }
  }, [])
  return [s, setS]
}

/** The button under "Send to my phone" (Reel page) and in the Export box. Renders nothing while posting is off. */
export function PostButton({ onClick, disabled, title, className = 'btn export-btn post-reel-btn', testid = 'post-youtube-reel' }: { onClick: () => void; disabled?: boolean; title?: string; className?: string; testid?: string }) {
  const [s] = usePostingStatus()
  if (!s?.enabled) return null
  return (
    <button className={className} onClick={onClick} disabled={disabled} title={title} data-testid={testid}>
      <Icon name="upload" size={className.includes('small') ? 16 : undefined} /> Post to YouTube
    </button>
  )
}
