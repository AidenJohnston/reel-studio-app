// Instagram and TikTok as Settings › Posting and Share see them (main/social-ipc.ts): can each be connected, and who
// is connected. Asked again when the window comes back, since a connection can end in the platform's own settings.
import { useCallback, useEffect, useState } from 'react'
import type { SocialStatus } from '../../../shared/social'
import { reel } from '../api'

export function useSocialStatus(): [SocialStatus | null, (fresh?: boolean) => Promise<void>] {
  const [s, setS] = useState<SocialStatus | null>(null)
  const reload = useCallback(async (fresh = false) => {
    const next = await reel.social.status(fresh).catch(() => null)
    if (next) setS(next)
  }, [])
  useEffect(() => {
    void reload()
    const back = () => void reload()
    window.addEventListener('focus', back)
    return () => window.removeEventListener('focus', back)
  }, [reload])
  return [s, reload]
}
