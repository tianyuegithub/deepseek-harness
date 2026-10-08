/** Real Loader composition and private HTTP consumer, with no model/provider calls. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '../src/index.ts'
import type { HostConnectionHandle } from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error)
    else resolve()
  }))
  return port
}

async function composition(enabled: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-managed-browser-'))
  const port = await freePort()
  const rows = [
    { id: 'credentials', name: 'cordis:managed-test-credentials',
      config: { path: join(dir, '.credentials.yaml'), watch: false } },
    { id: 'webserver', name: 'cordis:managed-test-webserver',
      config: { host: '127.0.0.1', port: 0 } },
    { id: 'connection', name: 'cordis:managed-test-connection', config: {
      trustedHosts: ['instance.example.test'],
      ...(enabled ? { managedBrowserSessions: { port, maxRecords: 3 } } : {}),
    } },
  ]
  const config = join(dir, 'cordis.yml')
  await writeFile(config, JSON.stringify(rows), { mode: 0o600 })
  // Pre-imported source modules share Vitest's Context identity. Native dynamic imports
  // otherwise select unbuilt package exports, mixing source and artifact programs.
  const ctx = await boot('dsh-managed-browser-test', config, undefined, (root) => {
    root.loader.builtins['managed-test-credentials'] = Credentials
    root.loader.builtins['managed-test-webserver'] = WebServer
    root.loader.builtins['managed-test-connection'] = Connection
  })
  const connection = ctx.get('connection') as HostConnectionHandle
  return { ctx, connection, port, dir }
}

interface WireCredential {
  opaque_id: string
  runtime_generation: string
  credential_kind: 'cookie'
  credential_value: string
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function foreignHostStatus(port: number): Promise<number | undefined> {
  // Node fetch ignores a supplied Host; node:http puts the tested value on the wire.
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/internal/access-readiness',
      headers: { host: 'evil.example' } }, (res) => {
      res.resume()
      res.once('end', () => { resolve(res.statusCode) })
    })
    req.once('error', reject)
    req.end()
  })
}

describe('managed browser private bridge through Loader', () => {
  it('creates, activates, authenticates, revokes, and releases the real listener', async () => {
    const { ctx, connection, port, dir } = await composition(true)
    try {
      const ready = await fetch(`http://127.0.0.1:${String(port)}/internal/access-readiness`)
      expect(ready.status).toBe(200)
      const readiness = await ready.json() as { api_version: number; runtime_generation: string; available: boolean }
      expect(readiness.api_version).toBe(1)
      expect(readiness.available).toBe(true)
      const body = { exchange_id: randomUUID(), runtime_generation: readiness.runtime_generation,
        public_origin: 'https://instance.example.test', absolute_expires_at_ms: Date.now() + 60_000 }
      const created = await post(port, '/internal/browser-sessions', body)
      expect(created.status).toBe(201)
      const credential = await created.json() as WireCredential
      const authRequest = { headers: { host: 'instance.example.test', cookie: credential.credential_value } }
      expect(connection.requestRejection(authRequest)).toBe(401)
      const again = await post(port, '/internal/browser-sessions', body)
      expect(again.status).toBe(201)
      const repeated = await again.json() as WireCredential
      expect(repeated.credential_value === credential.credential_value).toBe(true)
      expect((await post(port, `/internal/browser-sessions/${credential.opaque_id}/activate`, {
        runtime_generation: credential.runtime_generation,
      })).status).toBe(200)
      expect(connection.requestRejection(authRequest)).toBeUndefined()
      // Context type discovery alone does not export Remote calls: the live marker table is empty.
      expect(remoteMethods(connection)).toEqual([])
      const publicPath = '/api/connection/browserSessions/create'
      const publicResponse = await connection.createSharedFetchHandler('/api').fetch(
        new Request(`http://instance.example.test${publicPath}`, { method: 'POST' }),
      )
      expect(publicResponse.status).toBe(404)
      const revoked = await fetch(`http://127.0.0.1:${String(port)}/internal/browser-sessions/${credential.opaque_id}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime_generation: credential.runtime_generation }),
      })
      expect(revoked.status).toBe(200)
      expect(connection.requestRejection(authRequest)).toBe(401)
      expect((await post(port, '/internal/browser-sessions', body)).status).toBe(409)
      await ctx.fiber.dispose()
      expect(connection.browserSessions.readiness().available).toBe(false)
      await expect(fetch(`http://127.0.0.1:${String(port)}/internal/access-readiness`)).rejects.toThrow()
      // A subsequent Loader activation must bind the same port; refusal proves release did not finish.
      const rebound = createServer()
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject)
        rebound.listen(port, '127.0.0.1', resolve)
      })
      await new Promise<void>(resolve => rebound.close(() => { resolve() }))
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects browser origins, foreign Host, malformed inputs, and oversized bodies', async () => {
    const { ctx, port, dir } = await composition(true)
    try {
      const root = `http://127.0.0.1:${String(port)}`
      expect((await fetch(`${root}/internal/access-readiness`, { headers: { origin: root } })).status).toBe(403)
      expect(await foreignHostStatus(port)).toBe(403)
      expect((await post(port, '/internal/browser-sessions', {})).status).toBe(400)
      expect((await post(port, '/internal/browser-sessions', { padding: 'x'.repeat(4096) })).status).toBe(413)
      expect((await fetch(`${root}/internal/browser-sessions`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
      const ready = await (await fetch(`${root}/internal/access-readiness`)).json() as { runtime_generation: string }
      const input = { exchange_id: randomUUID(), runtime_generation: ready.runtime_generation,
        public_origin: 'https://instance.example.test', absolute_expires_at_ms: Date.now() + 60_000 }
      expect((await post(port, '/internal/browser-sessions', { ...input, public_origin: 'http://instance.example.test' })).status).toBe(400)
      expect((await post(port, '/internal/browser-sessions', { ...input, public_origin: 'https://instance.example.test/' })).status).toBe(400)
      expect((await post(port, '/internal/browser-sessions', { ...input, extra: true })).status).toBe(400)
      expect((await fetch(`${root}/api/connection/browserSessions/create`)).status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits the listener and disables the Host API without opt-in config', async () => {
    const { ctx, connection, port, dir } = await composition(false)
    try {
      expect(connection.browserSessions.readiness().available).toBe(false)
      await expect(fetch(`http://127.0.0.1:${String(port)}/internal/access-readiness`)).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes retained terminal replay from a new expired operation', async () => {
    const { ctx, port, dir } = await composition(true)
    try {
      const ready = await (await fetch(`http://127.0.0.1:${String(port)}/internal/access-readiness`)).json() as { runtime_generation: string }
      const input = { exchange_id: randomUUID(), runtime_generation: ready.runtime_generation,
        public_origin: 'https://instance.example.test', absolute_expires_at_ms: Date.now() + 60_000 }
      expect((await post(port, '/internal/browser-sessions', input)).status).toBe(201)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(input.absolute_expires_at_ms)
      try {
        expect((await post(port, '/internal/browser-sessions', input)).status).toBe(409)
        expect((await post(port, '/internal/browser-sessions', { ...input, exchange_id: randomUUID() })).status).toBe(400)
      } finally {
        clock.mockRestore()
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
