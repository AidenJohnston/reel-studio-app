import { withProjectLock } from './ai'

/** Serialize live renders with note publication; staged renders own their output. */
export function lockProjectEngine<Args extends [command: string, args: string[], ...options: unknown[]]>(engineRunner: (...options: Args) => Promise<unknown>) {
  return (...options: Args): Promise<unknown> => {
    const [command, args] = options
    const dir = args[args.indexOf('--project') + 1]
    const run = () => engineRunner(...options)
    return (command === 'render' || command === 'cover') && args.includes('--project') && dir && !args.includes('--out')
      ? withProjectLock(dir, run) : run()
  }
}
