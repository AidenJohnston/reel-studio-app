import type { ReelApi } from '../shared/api'

declare global {
  interface Window {
    reel: ReelApi
  }
}
export {}
