// Posting's status (main/posting.ts), kept current by main: sign-in, connect, disconnect, a subscription that ended.
// Nothing about posting shows unless it is turned on (REELSTUDIO_POSTING=1, `enabled`).
import { useEffect, useState } from 'react'
import type { PostingStatus } from '../../../shared/api'
import { reel } from '../api'

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
