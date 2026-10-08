/** Private loopback consumer of the Host browser-session API, never a Web route. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { BrowserSessionError } from './browser-sessions.ts'
import type {
  BrowserExchangeId,
  BrowserRuntimeGeneration,
  BrowserSessionId,
  HostBrowserSessions,
  ManagedBrowserCredential,
} from './browser-session-api.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const generationSchema = z.string().regex(UUID)
const createSchema = z.strictObject({
  exchange_id: z.string().regex(UUID),
  runtime_generation: generationSchema,
  public_origin: z.string().refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && url.username === '' && url.password === ''
    } catch {
      return false
    }
  }),
  absolute_expires_at_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
const generationBody = z.strictObject({ runtime_generation: generationSchema })
const MAX_BODY_BYTES = 4096

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'connection': 'close',
  })
  res.end(JSON.stringify(body))
}

function wireCredential(credential: ManagedBrowserCredential): object {
  return {
    opaque_id: credential.opaqueId,
    runtime_generation: credential.runtimeGeneration,
    credential_kind: credential.credentialKind,
    credential_value: credential.credentialValue,
    expires_at_ms: credential.expiresAt,
    activation_deadline_ms: credential.activationDeadline,
  }
}

function trusted(req: IncomingMessage, port: number): boolean {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${String(port)}`
    || req.headers.origin !== undefined || req.headers['transfer-encoding'] !== undefined) return false
  let hosts = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === 'host') hosts += 1
  }
  return hosts === 1
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('aborted', aborted)
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        cleanup()
        req.resume()
        resolve(undefined)
      } else chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const aborted = () => { cleanup(); reject(new BrowserSessionError(400)) }
    req.on('data', data)
    req.once('end', end)
    req.once('aborted', aborted)
  })
}

async function dispatch(
  api: HostBrowserSessions,
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!trusted(req, port)) {
    req.resume()
    reply(res, 403, { error: 'forbidden' })
    return
  }
  if (!api.readiness().available) {
    req.resume()
    reply(res, 503, { error: 'unavailable' })
    return
  }
  if (req.method === 'GET' && req.url === '/internal/access-readiness') {
    req.resume()
    const readiness = api.readiness()
    reply(res, 200, {
      api_version: readiness.apiVersion,
      runtime_generation: readiness.runtimeGeneration,
      available: readiness.available,
    })
    return
  }
  const match = /^\/internal\/browser-sessions\/([A-Za-z0-9_-]{43})(\/activate)?$/u.exec(req.url ?? '')
  const creating = req.method === 'POST' && req.url === '/internal/browser-sessions'
  const activating = req.method === 'POST' && match?.[2] === '/activate'
  const revoking = req.method === 'DELETE' && match !== null && match[2] === undefined
  if (!creating && !activating && !revoking) {
    req.resume()
    reply(res, 404, { error: 'not-found' })
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    req.resume()
    reply(res, 400, { error: 'invalid-input' })
    return
  }
  const bytes = await readBody(req)
  if (bytes === undefined) {
    reply(res, 413, { error: 'body-too-large' })
    return
  }
  const body: unknown = JSON.parse(bytes.toString('utf8'))
  if (creating) {
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) throw new BrowserSessionError(400)
    const data = parsed.data
    reply(res, 201, wireCredential(api.create({
      exchangeId: data.exchange_id as BrowserExchangeId,
      runtimeGeneration: data.runtime_generation as BrowserRuntimeGeneration,
      publicOrigin: data.public_origin,
      absoluteExpiresAt: data.absolute_expires_at_ms,
    })))
    return
  }
  const parsed = generationBody.safeParse(body)
  if (!parsed.success || match?.[1] === undefined) throw new BrowserSessionError(400)
  const id = match[1] as BrowserSessionId
  const generation = parsed.data.runtime_generation as BrowserRuntimeGeneration
  if (activating) reply(res, 200, wireCredential(api.activate(id, generation)))
  else {
    api.revoke(id, generation)
    reply(res, 200, { revoked: true })
  }
}

/**
 * Bind the private integration consumer to IPv4 loopback. A listen failure rejects.
 * @param api - Host-only owner; caller must disable it before disposing the listener.
 * @param port - explicit TCP port, validated by Connection config.
 * @returns disposer which closes all HTTP connections and awaits listener shutdown.
 */
export async function listenBrowserSessionBridge(api: HostBrowserSessions, port: number): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    dispatch(api, port, req, res).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return
      const status = error instanceof BrowserSessionError ? error.status
        : error instanceof SyntaxError ? 400 : 503
      reply(res, status, { error: 'request-rejected' })
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return async () => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    server.closeAllConnections()
    await closed
  }
}
