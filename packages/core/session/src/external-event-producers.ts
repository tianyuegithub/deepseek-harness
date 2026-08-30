import { Service, type Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'
import { snapshotJsonValue } from './json.ts'
import type { Session } from './index.ts'
import type {
  ExternalSessionEventProducerDeclaration,
  SessionEvent,
  SessionEventMap,
} from './types.ts'

const MAX_PRODUCER_LENGTH = 214
const MAX_VERSION_LENGTH = 128
const MAX_EVENT_TYPE_LENGTH = 160
const MAX_EVENT_TYPES = 256
const PRODUCER_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/

/** Runtime registration for one exact external event vocabulary. */
export interface ExternalSessionEventProducerRegistration<
  EventTypes extends readonly string[] = readonly string[],
> extends ExternalSessionEventProducerDeclaration {
  readonly eventTypes: EventTypes
  /** `read-only` registers historical cold-read compatibility without a writer. */
  readonly mode?: 'read-write' | 'read-only'
}

/** Producer-bound writer returned by the external event registry. */
export interface ExternalSessionEventProducerHandle<
  EventTypes extends readonly string[] = readonly string[],
> {
  readonly declaration: ExternalSessionEventProducerDeclaration
  append<Type extends EventTypes[number] & keyof SessionEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): SessionEvent<Type>
  dispose(): void
}

interface RegistrationEntry {
  readonly declaration: ExternalSessionEventProducerDeclaration
  readonly mode: 'read-write' | 'read-only'
  active: boolean
}

/** Stable key for one exact producer version. */
function producerKey(declaration: Pick<ExternalSessionEventProducerDeclaration, 'producer' | 'version'>): string {
  return `${declaration.producer}\0${declaration.version}`
}

/**
 * Compare two declarations by their complete canonical tuple.
 * @param left - first declaration.
 * @param right - second declaration.
 * @returns whether producer, version, and every ordered event name match.
 */
export function externalSessionEventProducerEquals(
  left: ExternalSessionEventProducerDeclaration,
  right: ExternalSessionEventProducerDeclaration,
): boolean {
  return left.producer === right.producer
    && left.version === right.version
    && left.eventTypes.length === right.eventTypes.length
    && left.eventTypes.every((eventType, index) => eventType === right.eventTypes[index])
}

/**
 * Validate one detached declaration without consulting runtime composition.
 * @param input - candidate durable declaration.
 * @returns assertion that narrows `input` to the validated declaration shape.
 */
export function assertExternalSessionEventProducerDeclaration(
  input: unknown,
): asserts input is ExternalSessionEventProducerDeclaration {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('external session event producer declaration must be a plain object')
  }
  const declaration = input as Record<string, unknown>
  const keys = Object.keys(declaration)
  if (keys.length !== 3 || !keys.includes('producer') || !keys.includes('version') || !keys.includes('eventTypes')) {
    throw new TypeError('external session event producer declaration must contain only producer, version, and eventTypes')
  }
  const producer = declaration['producer']
  if (typeof producer !== 'string' || producer.length === 0 || producer.length > MAX_PRODUCER_LENGTH
    || !PRODUCER_PATTERN.test(producer)) {
    throw new TypeError('external session event producer must be a canonical npm package name')
  }
  const version = declaration['version']
  if (typeof version !== 'string' || version.length === 0 || version.length > MAX_VERSION_LENGTH
    || !VERSION_PATTERN.test(version)) {
    throw new TypeError('external session event producer version must be a bounded resolved version')
  }
  const eventTypes = declaration['eventTypes']
  if (!Array.isArray(eventTypes) || eventTypes.length === 0 || eventTypes.length > MAX_EVENT_TYPES) {
    throw new TypeError(`external session event producer eventTypes must contain 1-${MAX_EVENT_TYPES} names`)
  }
  let previous: string | undefined
  for (const eventType of eventTypes) {
    if (typeof eventType !== 'string' || eventType.length === 0 || eventType.length > MAX_EVENT_TYPE_LENGTH
      || !EVENT_TYPE_PATTERN.test(eventType)) {
      throw new TypeError('external session event producer eventTypes must be bounded namespaced event names')
    }
    if (eventType === 'session/external-event-producer' || KNOWN_SESSION_EVENT_TYPES.has(eventType)) {
      throw new TypeError(`external session event type "${eventType}" collides with the first-party vocabulary`)
    }
    if (previous !== undefined && previous >= eventType) {
      throw new TypeError('external session event producer eventTypes must be unique and sorted')
    }
    previous = eventType
  }
}

/** Snapshot, validate, and freeze one registration declaration. */
function snapshotDeclaration(input: ExternalSessionEventProducerDeclaration): ExternalSessionEventProducerDeclaration {
  const snapshot = snapshotJsonValue({
    producer: input.producer,
    version: input.version,
    eventTypes: input.eventTypes,
  })
  if (snapshot === undefined) {
    throw new TypeError('external session event producer declaration is not losslessly JSON-serializable')
  }
  assertExternalSessionEventProducerDeclaration(snapshot)
  return Object.freeze({
    producer: snapshot.producer,
    version: snapshot.version,
    eventTypes: Object.freeze([...snapshot.eventTypes]),
  })
}

/**
 * Fiber-scoped registry for required repository-external log-only event
 * producers. Registrations determine whether a durable declaration can be
 * interpreted; only a producer-bound handle can write the supported shape.
 */
export class ExternalSessionEventProducerRegistry {
  private readonly registrations = new Map<string, RegistrationEntry>()
  private readonly eventOwners = new Map<string, string>()

  constructor(private readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, {
      value: { property: 'ctx' },
    })
  }

  /**
   * Register one exact writer or historical read-compatible vocabulary.
   * @param registration - canonical producer tuple and runtime access mode.
   * @returns producer-bound handle owned by the calling fiber.
   */
  register<const EventTypes extends readonly string[]>(
    registration: ExternalSessionEventProducerRegistration<EventTypes>,
  ): ExternalSessionEventProducerHandle<EventTypes> {
    const declaration = snapshotDeclaration(registration)
    const candidateMode: unknown = registration.mode ?? 'read-write'
    if (candidateMode !== 'read-write' && candidateMode !== 'read-only') {
      throw new TypeError('external session event producer mode must be "read-write" or "read-only"')
    }
    const mode = candidateMode
    const key = producerKey(declaration)
    if (this.registrations.has(key)) {
      throw new Error(`external session event producer "${declaration.producer}" version "${declaration.version}" is already registered`)
    }
    for (const eventType of declaration.eventTypes) {
      const owner = this.eventOwners.get(eventType)
      if (owner !== undefined && owner !== declaration.producer) {
        throw new Error(`external session event type "${eventType}" is already owned by producer "${owner}"`)
      }
    }

    const entry: RegistrationEntry = { declaration, mode, active: true }
    const dispose = this.ctx.effect(() => {
      this.registrations.set(key, entry)
      for (const eventType of declaration.eventTypes) this.eventOwners.set(eventType, declaration.producer)
      return () => {
        if (this.registrations.get(key) !== entry) return
        this.registrations.delete(key)
        entry.active = false
        for (const eventType of declaration.eventTypes) {
          const stillOwned = [...this.registrations.values()].some(candidate =>
            candidate.declaration.producer === declaration.producer
            && candidate.declaration.eventTypes.includes(eventType))
          if (!stillOwned && this.eventOwners.get(eventType) === declaration.producer) {
            this.eventOwners.delete(eventType)
          }
        }
      }
    }, 'sessions.externalEventProducers.register()')

    return {
      declaration,
      append: <Type extends EventTypes[number] & keyof SessionEventMap>(
        session: Session,
        type: Type,
        data: SessionEventMap[Type],
      ): SessionEvent<Type> => this.append(entry, session, type, data),
      dispose: () => { void dispose() },
    }
  }

  /**
   * Require an exact active registration for a durable declaration.
   * @param input - declaration loaded from one session log.
   * @returns the matching active canonical declaration.
   */
  requireReadable(input: unknown): ExternalSessionEventProducerDeclaration {
    assertExternalSessionEventProducerDeclaration(input)
    const declaration = input
    const entry = this.registrations.get(producerKey(declaration))
    if (entry === undefined || !entry.active) {
      const versions = [...this.registrations.values()]
        .filter(candidate => candidate.declaration.producer === declaration.producer)
        .map(candidate => candidate.declaration.version)
      if (versions.length > 0) {
        throw new Error(`required external session event producer "${declaration.producer}" version "${declaration.version}" is not registered (available: ${versions.join(', ')})`)
      }
      throw new Error(`required external session event producer "${declaration.producer}" version "${declaration.version}" is not registered`)
    }
    if (!externalSessionEventProducerEquals(entry.declaration, declaration)) {
      throw new Error(`required external session event producer "${declaration.producer}" version "${declaration.version}" has a different event set`)
    }
    return entry.declaration
  }

  /** Append through one active producer-bound handle. */
  private append<Type extends keyof SessionEventMap>(
    entry: RegistrationEntry,
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): SessionEvent<Type> {
    if (!entry.active || this.registrations.get(producerKey(entry.declaration)) !== entry) {
      throw new Error(`external session event producer "${entry.declaration.producer}" version "${entry.declaration.version}" is disposed`)
    }
    if (entry.mode === 'read-only') {
      throw new Error(`external session event producer "${entry.declaration.producer}" version "${entry.declaration.version}" is registered read-only`)
    }
    if (!entry.declaration.eventTypes.includes(type)) {
      throw new Error(`event type "${type}" is not owned by external producer "${entry.declaration.producer}"`)
    }
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }

    let matchingDeclaration = false
    for (const event of session.events) {
      if (event.type === 'session/external-event-producer') {
        assertExternalSessionEventProducerDeclaration(event.data)
        const persisted = event.data
        const overlaps = persisted.eventTypes.some(eventType => entry.declaration.eventTypes.includes(eventType))
        if (persisted.producer !== entry.declaration.producer && overlaps) {
          throw new Error(`session "${session.id}" already assigns an event type to producer "${persisted.producer}"`)
        }
        if (persisted.producer !== entry.declaration.producer) continue
        if (matchingDeclaration || !externalSessionEventProducerEquals(persisted, entry.declaration)) {
          throw new Error(`session "${session.id}" has a conflicting declaration for external producer "${entry.declaration.producer}"`)
        }
        matchingDeclaration = true
        continue
      }
      if (!matchingDeclaration && entry.declaration.eventTypes.includes(event.type)) {
        throw new Error(`session "${session.id}" contains external event "${event.type}" before its producer declaration`)
      }
    }

    if (!matchingDeclaration) {
      session.append('session/external-event-producer', entry.declaration)
    }
    const writableSession = session as unknown as {
      append(eventType: string, eventData: unknown): SessionEvent
    }
    return writableSession.append(type, dataSnapshot) as SessionEvent<Type>
  }
}
