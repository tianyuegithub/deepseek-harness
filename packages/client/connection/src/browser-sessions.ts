/** Native in-memory managed browser authentication record owner. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { BrowserExchangeId, BrowserSessionId, BrowserRuntimeGeneration, BrowserSessionCreate, ManagedBrowserCredential, BrowserSessionsReadiness, HostBrowserSessions, ManagedBrowserCookiePayload } from './browser-session-api.ts'

/** Integration failures use fixed status codes without secret or stack details. */
export class BrowserSessionError extends Error {
  /**
   * Create a public integration failure.
   * @param status - wire response status for this failure.
   */
  constructor(readonly status: 400 | 404 | 409 | 429 | 503) {
    super('managed browser session request rejected')
  }
}

interface SessionRecord {
  input: BrowserSessionCreate
  credential: ManagedBrowserCredential
  state: 'pending' | 'active' | 'terminal'
  retainUntil: number
}

const PENDING_MILLISECONDS = 60_000
const TERMINAL_MILLISECONDS = 5 * 60_000

/** In-memory record owner; synchronous transitions cannot interleave within an activation. */
export class ManagedBrowserSessions implements HostBrowserSessions {
  private readonly generation = randomUUID() as BrowserRuntimeGeneration
  private readonly sessions = new Map<BrowserSessionId, SessionRecord>()
  private readonly operations = new Map<BrowserExchangeId, BrowserSessionId>()
  private disposed = false

  /**
   * Bind record creation to the native signing owner.
   * @param maxRecords - explicit capacity; undefined disables every managed operation.
   * @param maxAgeMilliseconds - Connection's maximum cookie lifetime.
   * @param encode - BrowserAuth-owned cookie signer returning the complete header value.
   */
  constructor(
    private readonly maxRecords: number | undefined,
    private readonly maxAgeMilliseconds: number,
    private readonly encode: (payload: ManagedBrowserCookiePayload) => string,
  ) {}

  readiness(): BrowserSessionsReadiness {
    return { apiVersion: 1, runtimeGeneration: this.generation, available: this.enabled() }
  }

  create(input: BrowserSessionCreate): ManagedBrowserCredential {
    const capacity = this.assertGeneration(input.runtimeGeneration)
    const now = Date.now()
    this.sweep(now)
    const existingId = this.operations.get(input.exchangeId)
    const existing = existingId === undefined ? undefined : this.sessions.get(existingId)
    if (existing !== undefined) {
      if (existing.state === 'terminal' || existing.input.publicOrigin !== input.publicOrigin
        || existing.input.absoluteExpiresAt !== input.absoluteExpiresAt) throw new BrowserSessionError(409)
      return existing.credential
    }
    if (!Number.isSafeInteger(input.absoluteExpiresAt) || input.absoluteExpiresAt <= now
      || input.absoluteExpiresAt - now > this.maxAgeMilliseconds) throw new BrowserSessionError(400)
    if (this.sessions.size >= capacity) throw new BrowserSessionError(429)
    const id = randomBytes(32).toString('base64url') as BrowserSessionId
    const payload: ManagedBrowserCookiePayload = {
      version: 2,
      authority: new URL(input.publicOrigin).host,
      issuedAt: now,
      expiresAt: input.absoluteExpiresAt,
      sessionId: id,
      runtimeGeneration: this.generation,
    }
    const credential: ManagedBrowserCredential = Object.freeze({
      opaqueId: id,
      runtimeGeneration: this.generation,
      credentialKind: 'cookie',
      credentialValue: this.encode(payload),
      expiresAt: input.absoluteExpiresAt,
      activationDeadline: Math.min(now + PENDING_MILLISECONDS, input.absoluteExpiresAt),
    })
    this.sessions.set(id, { input: { ...input }, credential, state: 'pending', retainUntil: 0 })
    this.operations.set(input.exchangeId, id)
    return credential
  }

  activate(id: BrowserSessionId, generation: BrowserRuntimeGeneration): ManagedBrowserCredential {
    this.assertGeneration(generation)
    this.sweep(Date.now())
    const record = this.sessions.get(id)
    if (record === undefined) throw new BrowserSessionError(404)
    if (record.state === 'terminal') throw new BrowserSessionError(409)
    record.state = 'active'
    return record.credential
  }

  revoke(id: BrowserSessionId, generation: BrowserRuntimeGeneration): void {
    this.assertGeneration(generation)
    const now = Date.now()
    this.sweep(now)
    const record = this.sessions.get(id)
    if (record !== undefined) this.terminate(record, now)
  }

  /**
   * Verify a signed managed payload against its current active record.
   * @param payload - payload whose signature BrowserAuth has already verified.
   * @returns true only while this activation and its exact credential remain active.
   */
  accepts(payload: ManagedBrowserCookiePayload): boolean {
    if (!this.enabled() || payload.runtimeGeneration !== this.generation) return false
    this.sweep(Date.now())
    const record = this.sessions.get(payload.sessionId)
    return record?.state === 'active'
      && record.credential.expiresAt === payload.expiresAt
      && new URL(record.input.publicOrigin).host === payload.authority
  }

  /** Revoke all managed authentication synchronously before asynchronous listener disposal. */
  dispose(): void {
    this.disposed = true
    this.sessions.clear()
    this.operations.clear()
  }

  private enabled(): boolean {
    return this.maxRecords !== undefined && !this.disposed
  }

  private assertGeneration(generation: BrowserRuntimeGeneration): number {
    if (this.maxRecords === undefined || this.disposed) throw new BrowserSessionError(503)
    if (generation !== this.generation) throw new BrowserSessionError(409)
    return this.maxRecords
  }

  private terminate(record: SessionRecord, now: number): void {
    if (record.state === 'terminal') return
    record.state = 'terminal'
    record.retainUntil = Math.max(record.credential.expiresAt, now + TERMINAL_MILLISECONDS)
  }

  private sweep(now: number): void {
    for (const [id, record] of this.sessions) {
      if (record.credential.expiresAt <= now
        || (record.state === 'pending' && record.credential.activationDeadline <= now)) {
        this.terminate(record, now)
      }
      if (record.state === 'terminal' && record.retainUntil <= now) {
        this.sessions.delete(id)
        this.operations.delete(record.input.exchangeId)
      }
    }
  }
}
