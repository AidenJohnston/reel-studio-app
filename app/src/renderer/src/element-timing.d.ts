import 'react'

declare module 'react' {
  interface HTMLAttributes<T> {
    /** Element Timing: Chromium records when this element is first painted. Names: src/shared/perf-marks.ts. */
    elementtiming?: string
  }
}
