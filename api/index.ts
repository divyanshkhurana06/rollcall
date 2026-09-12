import type { IncomingMessage, ServerResponse } from 'node:http'
// Built by `npm run build:api` (esbuild, our sources only; packages stay external).
import app from './_server.mjs'

/**
 * Vercel entry. The web is served statically from apps/web/dist and calls `/api/...`; this function
 * strips that prefix and hands the request to the same Express app that `npm run api` runs locally.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = (req.url ?? '/').replace(/^\/api(?=\/|\?|$)/, '') || '/'
  return (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
}
