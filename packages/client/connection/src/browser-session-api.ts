/** Host-only managed browser session types; this module has no Node runtime imports. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** An operation UUID validated by the integration's wire parser. */
export type BrowserExchangeId = Branded<'BrowserExchangeId'>
/** Opaque native session identifier. */
export type BrowserSessionId = Branded<'BrowserSessionId'>
/** One Connection activation, independent of its persistent signing secret. */
export type BrowserRuntimeGeneration = Branded<'BrowserRuntimeGeneration'>

/** Explicit opt-in and retained-record capacity for the private bridge. */
export interface ManagedBrowserSessionsConfig {
  /** Loopback TCP port; no all-interface bind is supported. */
  port: number
  /** Pending, active, and retained terminal records share this hard limit. */
  maxRecords: number
}

/** Validated integration input; time is in Unix milliseconds. */
export interface BrowserSessionCreate {
  exchangeId: BrowserExchangeId
  runtimeGeneration: BrowserRuntimeGeneration
  publicOrigin: string
  absoluteExpiresAt: number
}

/** Secret server-side credential; callers must never log or send it to a browser. */
export interface ManagedBrowserCredential {
  readonly opaqueId: BrowserSessionId
  readonly runtimeGeneration: BrowserRuntimeGeneration
  readonly credentialKind: 'cookie'
  /** Complete Cookie request-header value, without Set-Cookie attributes. */
  readonly credentialValue: string
  readonly expiresAt: number
  readonly activationDeadline: number
}

/** Readiness carries no credential and changes on every Connection activation. */
export interface BrowserSessionsReadiness {
  readonly apiVersion: 1
  readonly runtimeGeneration: BrowserRuntimeGeneration
  readonly available: boolean
}

/** Host-only API. Disabled or disposed owners reject every mutation with 503. */
export interface HostBrowserSessions {
  /** @returns readiness for this activation without authentication material. */
  readiness(): BrowserSessionsReadiness
  /**
   * Create a pending credential; identical retained live requests are idempotent.
   * @param input - validated operation, generation, origin, and absolute deadline.
   * @returns credential requiring activation within 60 seconds; throws on conflict or capacity.
   */
  create(input: BrowserSessionCreate): ManagedBrowserCredential
  /**
   * Activate a live pending credential, or accept an already active one.
   * @param id - opaque identifier from create.
   * @param generation - generation from readiness.
   * @returns the active credential; terminal, expired, and foreign records reject.
   */
  activate(id: BrowserSessionId, generation: BrowserRuntimeGeneration): ManagedBrowserCredential
  /**
   * Revoke one credential immediately; an unknown identifier is an idempotent no-op.
   * @param id - opaque identifier from create.
   * @param generation - generation from readiness; a stale generation rejects.
   */
  revoke(id: BrowserSessionId, generation: BrowserRuntimeGeneration): void
}

/** Version-2 payload signed exclusively by BrowserAuth. */
export interface ManagedBrowserCookiePayload {
  readonly version: 2
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly sessionId: BrowserSessionId
  readonly runtimeGeneration: BrowserRuntimeGeneration
}
