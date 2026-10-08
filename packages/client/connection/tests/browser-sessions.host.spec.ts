/** Host-managed browser-session lifecycle and retention behavior. */

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type {
  BrowserExchangeId,
  BrowserRuntimeGeneration,
  BrowserSessionCreate,
  BrowserSessionId,
} from '../src/browser-session-api.ts'
import { BrowserSessionError } from '../src/browser-sessions.ts'
import { RecordCredentials } from './browser-credentials.ts'

const BASE_TIME = new Date('2026-10-07T00:00:00.000Z').getTime()
const AUTHORITY = '127.0.0.1:3080'
const ORIGIN = `https://${AUTHORITY}`
const MINUTE = 60_000

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function exchangeId(value: string): BrowserExchangeId {
  const hash = createHash('sha256').update(value).digest('hex')
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}`
    + `-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return uuid as BrowserExchangeId
}

function sessionId(value: string): BrowserSessionId {
  return value as BrowserSessionId
}

function generation(value: string): BrowserRuntimeGeneration {
  return value as BrowserRuntimeGeneration
}

function input(
  auth: BrowserAuth,
  operation: string,
  absoluteExpiresAt = Date.now() + 10 * MINUTE,
  publicOrigin = ORIGIN,
): BrowserSessionCreate {
  return {
    exchangeId: exchangeId(operation),
    runtimeGeneration: auth.browserSessions.readiness().runtimeGeneration,
    publicOrigin,
    absoluteExpiresAt,
  }
}

function request(cookie: string, authority = AUTHORITY): { headers: Record<string, string> } {
  return { headers: { host: authority, cookie } }
}

function expectStatus(
  operation: () => unknown,
  status: BrowserSessionError['status'],
): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BrowserSessionError)
    expect((error as BrowserSessionError).status).toBe(status)
    return
  }
  throw new Error(`expected BrowserSessionError status ${String(status)}`)
}

function createAuth(
  store: RecordCredentials,
  maxRecords?: number,
): Promise<BrowserAuth> {
  return BrowserAuth.create({}, credentials(store), 1, maxRecords)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth managed browser sessions', () => {
  it('keeps omitted capacity disabled with 503 mutations and rejects signed v2 cookies', async () => {
    const store = new RecordCredentials()
    const enabled = await createAuth(store, 2)
    const credential = enabled.browserSessions.create(input(enabled, 'enabled'))
    enabled.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)
    expect(enabled.isAuthenticated(request(credential.credentialValue))).toBe(true)

    const disabled = await createAuth(store)
    const readiness = disabled.browserSessions.readiness()
    expect(readiness).toMatchObject({ apiVersion: 1, available: false })
    expect(disabled.isAuthenticated(request(credential.credentialValue))).toBe(false)
    expectStatus(() => disabled.browserSessions.create({
      ...input(disabled, 'disabled'),
      runtimeGeneration: readiness.runtimeGeneration,
    }), 503)
    expectStatus(() => disabled.browserSessions.activate(
      sessionId('disabled-session'), readiness.runtimeGeneration,
    ), 503)
    expectStatus(() => {
      disabled.browserSessions.revoke(sessionId('disabled-session'), readiness.runtimeGeneration)
    }, 503)
  })

  it('rejects pending credentials then accepts activation immediately and idempotently', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const credential = auth.browserSessions.create(input(auth, 'activate'))

    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(false)
    expect(auth.browserSessions.activate(
      credential.opaqueId, credential.runtimeGeneration,
    )).toBe(credential)
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(true)
    expect(auth.browserSessions.activate(
      credential.opaqueId, credential.runtimeGeneration,
    )).toBe(credential)
  })

  it('returns the identical credential for one live operation and rejects changed inputs', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const create = input(auth, 'idempotent-create')
    const credential = auth.browserSessions.create(create)

    expect(auth.browserSessions.create(create)).toBe(credential)
    expectStatus(() => auth.browserSessions.create({
      ...create,
      publicOrigin: 'https://localhost:3080',
    }), 409)
    expectStatus(() => auth.browserSessions.create({
      ...create,
      absoluteExpiresAt: create.absoluteExpiresAt + 1,
    }), 409)
  })

  it('rejects the wrong authority and foreign runtime generation', async () => {
    const auth = await createAuth(new RecordCredentials(), 2)
    const credential = auth.browserSessions.create(input(auth, 'binding'))
    auth.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)
    expect(auth.isAuthenticated(request(credential.credentialValue, 'localhost:3080'))).toBe(false)

    const foreignGeneration = generation('foreign-runtime-generation')
    expectStatus(() => auth.browserSessions.create({
      ...input(auth, 'foreign-create'),
      runtimeGeneration: foreignGeneration,
    }), 409)
    expectStatus(() => auth.browserSessions.activate(
      credential.opaqueId, foreignGeneration,
    ), 409)
    expectStatus(() => {
      auth.browserSessions.revoke(credential.opaqueId, foreignGeneration)
    }, 409)
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(true)
  })

  it('revokes immediately and rejects the retained operation replay', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const create = input(auth, 'revoked')
    const credential = auth.browserSessions.create(create)
    auth.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)

    auth.browserSessions.revoke(credential.opaqueId, credential.runtimeGeneration)
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(false)
    expectStatus(() => auth.browserSessions.activate(
      credential.opaqueId, credential.runtimeGeneration,
    ), 409)
    expectStatus(() => auth.browserSessions.create(create), 409)
  })

  it('allows activation before 60 seconds and rejects it at the exact boundary', async () => {
    const auth = await createAuth(new RecordCredentials(), 2)
    const before = auth.browserSessions.create(input(auth, 'before-boundary'))
    const at = auth.browserSessions.create(input(auth, 'at-boundary'))

    vi.setSystemTime(BASE_TIME + MINUTE - 1)
    expect(auth.browserSessions.activate(before.opaqueId, before.runtimeGeneration)).toBe(before)
    vi.setSystemTime(BASE_TIME + MINUTE)
    expectStatus(() => auth.browserSessions.activate(at.opaqueId, at.runtimeGeneration), 409)
    expect(auth.isAuthenticated(request(before.credentialValue))).toBe(true)
  })

  it('stops authentication at the exact absolute expiry', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const expiresAt = BASE_TIME + 30_000
    const credential = auth.browserSessions.create(input(auth, 'absolute-expiry', expiresAt))
    auth.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)

    vi.setSystemTime(expiresAt - 1)
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(true)
    vi.setSystemTime(expiresAt)
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(false)
    expectStatus(() => auth.browserSessions.activate(
      credential.opaqueId, credential.runtimeGeneration,
    ), 409)
  })

  it('retains terminal records for at least five minutes and does not evict on 429', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const revokedInput = input(auth, 'five-minute-retention', BASE_TIME + 2 * MINUTE)
    const revoked = auth.browserSessions.create(revokedInput)
    auth.browserSessions.revoke(revoked.opaqueId, revoked.runtimeGeneration)

    vi.setSystemTime(BASE_TIME + 5 * MINUTE - 1)
    expectStatus(() => auth.browserSessions.create(input(auth, 'capacity-blocked')), 429)
    // Input validation precedes retained-operation lookup once its absolute deadline has passed.
    expectStatus(() => auth.browserSessions.create(revokedInput), 409)
    vi.setSystemTime(BASE_TIME + 5 * MINUTE)
    expectStatus(() => auth.browserSessions.create(revokedInput), 400)
    expect(auth.browserSessions.create(input(auth, 'capacity-released'))).toBeDefined()
  })

  it('retains a terminal record until a later absolute expiry', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const absoluteExpiresAt = BASE_TIME + 10 * MINUTE
    const credential = auth.browserSessions.create(input(auth, 'absolute-retention', absoluteExpiresAt))
    auth.browserSessions.revoke(credential.opaqueId, credential.runtimeGeneration)

    vi.setSystemTime(BASE_TIME + 5 * MINUTE)
    expectStatus(() => auth.browserSessions.create(input(auth, 'still-retained')), 429)
    vi.setSystemTime(absoluteExpiresAt)
    expect(auth.browserSessions.create(input(auth, 'absolute-released'))).toBeDefined()
  })

  it('rejects an old v2 credential after reload with the same persistent secret', async () => {
    const store = new RecordCredentials()
    const first = await createAuth(store, 1)
    const credential = first.browserSessions.create(input(first, 'before-reload'))
    first.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)
    const persistentRecord = store.record

    const reloaded = await createAuth(store, 1)
    expect(store.record).toBe(persistentRecord)
    expect(reloaded.browserSessions.readiness().runtimeGeneration)
      .not.toBe(credential.runtimeGeneration)
    expect(reloaded.isAuthenticated(request(credential.credentialValue))).toBe(false)
  })

  it('invalidates active credentials and rejects every mutation after dispose', async () => {
    const auth = await createAuth(new RecordCredentials(), 1)
    const credential = auth.browserSessions.create(input(auth, 'dispose'))
    auth.browserSessions.activate(credential.opaqueId, credential.runtimeGeneration)
    auth.browserSessions.dispose()

    expect(auth.browserSessions.readiness()).toMatchObject({ apiVersion: 1, available: false })
    expect(auth.isAuthenticated(request(credential.credentialValue))).toBe(false)
    expectStatus(() => auth.browserSessions.create(input(auth, 'after-dispose')), 503)
    expectStatus(() => auth.browserSessions.activate(
      credential.opaqueId, credential.runtimeGeneration,
    ), 503)
    expectStatus(() => {
      auth.browserSessions.revoke(credential.opaqueId, credential.runtimeGeneration)
    }, 503)
  })
})
