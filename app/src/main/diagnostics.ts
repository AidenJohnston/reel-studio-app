export async function logDuration<T>(label: string, log: (line: string) => void, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  log(`${label} started`)
  let outcome = 'failed'
  try {
    const result = await operation()
    outcome = 'completed'
    return result
  } finally {
    log(`${label} ${outcome} durationMs=${Math.round(performance.now() - started)}`)
  }
}
