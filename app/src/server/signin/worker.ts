// The sign-in service on Cloudflare Workers (docs/signin.md, "Deploy"). Settings come from the Worker's variables
// and secrets; a missing or half-set platform makes every request fail with the setup error, loudly, in the logs.
import { configFromEnv } from './config.ts'
import { createSigninHandler } from './handler.ts'

let handler: ((req: Request) => Promise<Response>) | null = null

export default {
  async fetch(req: Request, env: Record<string, string | undefined>): Promise<Response> {
    handler ??= createSigninHandler(configFromEnv(env, (url, init) => fetch(url, init)))
    return handler(req)
  }
}
