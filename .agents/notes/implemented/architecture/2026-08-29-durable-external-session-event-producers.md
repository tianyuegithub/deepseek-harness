# Agent Note: Durable declarations for external session event producers

Status: implemented

English | [中文](2026-08-29-durable-external-session-event-producers.zh.md)

## Problem

`SessionEventMap` is intentionally merge-extensible, so a repository-external Host package can compile code that appends its own log-only session events. Persistence currently accepts those events while the process is live, but `PersistenceCoordinator` refuses them on the first cold read because `KNOWN_SESSION_EVENT_TYPES` contains only declarations generated from this repository. This fail-closed behavior prevents silent semantic loss, but it also means an installed external product cannot use the Session Log as its durable source of truth.

The persisted log must state which external code is required to interpret it. A process-local allow-list is insufficient: the same artifact would become readable or unreadable according to whichever plugins happen to be mounted, with no durable evidence of which producer wrote each event vocabulary. Ignoring an event, reusing a first-party event name, disabling the known-type check, or shipping a private persistence fork would all weaken the invariant that a successful read reconstructs the complete session meaning.

PactFlow is the first concrete external consumer. Its project state needs required log-only events, cold recovery, plugin removal that preserves artifacts, and exact reinstall recovery. The mechanism must remain generic and must not add PactFlow names or behavior to DSH core.

## Decision

### One core declaration event

Add one first-party log-only event, `session/external-event-producer`, whose immutable payload records:

```ts
interface ExternalSessionEventProducerDeclaration {
  readonly producer: string
  readonly version: string
  readonly eventTypes: readonly string[]
}
```

`producer` is the published package identity, `version` is the resolved package version, and `eventTypes` is the sorted exact set this producer may append. The tuple itself is the durable vocabulary identity; a digest adds no trust or information and is therefore not persisted. The declaration payload is lossless JSON, contains no executable schema, and is validated by core for non-empty bounded values, canonical ordering, unique names, namespace syntax, and collisions with first-party event types.

The declaration event is required-on-read but remains interpretable by core. An older DSH build does not know this new event and therefore refuses the log through the existing unknown-event rule. The event envelope and `SessionHeader` shape do not change, so `SESSION_FORMAT_VERSION` does not change.

### SessionStore-owned producer registry

`SessionStore` owns a fiber-scoped external producer registry exposed through `ctx.sessions.externalEventProducers`. A trusted Host plugin registers one exact declaration during composition. Registration rejects duplicate producer/version identities, event types claimed by two producers, first-party event names, invalid names, and a declaration whose canonical event set differs from an already registered identity. Disposal removes the runtime registration and prevents its handle from appending again.

Registration returns a producer-bound handle. The supported append path is equivalent to:

```ts
declare const ctx: {
  sessions: {
    externalEventProducers: {
      register(options: { producer: string; version: string; eventTypes: readonly string[] }): {
        append(session: unknown, type: string, payload: unknown): void
      }
    }
  }
}
declare const session: unknown
declare const payload: unknown

const pactflowEvents = ctx.sessions.externalEventProducers.register({
  producer: '@nous/dsh-pactflow',
  version: '0.1.0',
  eventTypes: ['pactflow/project-initialized'],
})

pactflowEvents.append(session, 'pactflow/project-initialized', payload)
```

The handle accepts only its exact event types and only log-only payloads. It validates the target event completely before mutating the log. On the first append for that producer identity in one session, it synchronously appends `session/external-event-producer` and then the target event with no asynchronous gap. Later appends reuse the matching declaration. A conflicting declaration, a disposed handle, a session carrying a different producer version or event set, or an event outside the handle's set fails before the target event enters the log.

Direct `session.append()` remains the first-party typed primitive. Repository-external packages must use the producer-bound handle for durable events. A package that bypasses the handle may still construct a merge-typed event in JavaScript, but that event has no admitted declaration and the persistence reader refuses it; no bypass becomes a supported persistence path.

### Deterministic read admission

`PersistenceCoordinator.assertEventsSupported()` scans normalized events in sequence with a per-read admitted set initialized from `KNOWN_SESSION_EVENT_TYPES`.

1. A `session/external-event-producer` event is structurally validated.
2. Its exact declaration must be present in the current runtime registry. A missing producer, version mismatch, or event-set mismatch throws `SessionFormatUnsupportedError` naming the producer identity and raw artifact when available.
3. The declared event names are added to that log's admitted set. A name already admitted by another producer or by core is rejected.
4. A later non-core event is accepted only when an earlier valid declaration admitted its exact type. An external event before its declaration is rejected at that sequence.

The reader never treats registration alone as permission. It also never ignores a declaration because no matching external event follows. A declaration means the session requires that exact producer to establish faithful semantics.

JSONL and SQLite store the declaration as an ordinary logical event. Suffix reads preserve the existing scope rule: a seek-capable backend may only validate the returned suffix, but if that suffix contains an external event without its declaration, the coordinator falls back to the complete stored prefix before deciding support. This is the same class of prefix dependency as supported legacy normalization and must not make SQLite accept a suffix that full JSONL reading rejects.

### Upgrade, removal, and compatibility

Removing an external Bundle removes its runtime registration after Profile restart. Session headers remain listable and raw artifacts remain untouched, but reading a log that declares the missing producer fails with `SessionFormatUnsupportedError`. Reinstalling the exact producer/version/event-set registration restores reading without rewriting the log.

A newer plugin version does not implicitly claim compatibility with an older declaration. A release that intentionally supports old logs registers an additional read-compatible declaration for that exact historical tuple and keeps payload-version folds that prove the claim. The current writer handle registers and appends only its current declaration. Optional external events, wildcard namespaces, compatible-version ranges, schema-driven migration, and skipping events while a producer is absent are outside the first contract.

### Scope and ownership

DSH core owns declaration validation, lifecycle registration, append ordering, persistence admission, and diagnostics. External producers own their payload schemas, payload `v` fields, folds, projections, migrations, and compatibility registrations. The registry does not execute plugin code during persistence parsing and does not make persistence depend on a Web Client, Agent Preset, or model tool.

The feature is a generic external-extension contract. PactFlow consumes it from a standalone repository only after the mechanism is part of a supported DSH release; no PactFlow package, event name, projection, or migration lands in this repository.

## Alternatives considered

**Use the currently mounted event-name set.** Rejected because artifact readability would vary without durable producer evidence, recreating the composition-dependent behavior the existing fail-closed decision explicitly avoided.

**Add producer declarations to `SessionHeader`.** Rejected for the first implementation because the header is immutable and fixed at session creation. A product introduced later could not add its first event without forking or rewriting the only artifact, and a header-shape change would unnecessarily engage format-version migration.

**Persist a vocabulary digest instead of exact event names.** Rejected because the reader still needs the exact names to admit events, and an unkeyed digest proves neither package authenticity nor schema compatibility. Exact canonical tuples are smaller in concept and produce better diagnostics.

**Persist executable schemas or adopt a runtime schema registry for every event.** Rejected because that is the repository-wide vocabulary redesign already analyzed in the runtime-schema Agent Note. This proposal only establishes durable ownership and required-reader presence; producers retain payload validation and versioning.

**Allow missing producers and skip their events.** Rejected because an unknown durable fact may affect projections, authorization, recovery, or later model input. The reader cannot infer that it is optional.

**Bump `SESSION_FORMAT_VERSION`.** Rejected because neither the header nor event envelope changes. Older readers already fail safely on the new first-party declaration event, while newer readers continue to read old logs with no declarations.

**Patch the persistence coordinator in each external product.** Rejected because it forks the trust boundary, breaks Profile portability, and makes uninstall or DSH upgrade behavior product-specific.

## Testing

- Core unit tests validate declaration shape, canonical order, bounds, namespaces, first-party collisions, duplicate producer identities, duplicate event ownership, disposal, and conflicting declarations.
- A producer-bound append writes exactly one declaration before its first event, writes no duplicate declaration, and leaves the log unchanged when target validation fails.
- JSONL and SQLite contract tests persist and cold-read a declared external event with the matching producer registered.
- Both backends reject an external event before declaration, an undeclared event, a missing producer, a version mismatch, an event-set mismatch, and ownership conflicts with `SessionFormatUnsupportedError` diagnostics that name the producer/event and raw artifact when available.
- Full reads and suffix reads make the same admission decision; a suffix whose required declaration is outside the returned range falls back to the prefix rather than over-accepting or over-refusing.
- Unregistering the producer simulates Bundle removal and makes cold read fail without changing the artifact; registering the exact tuple again restores the read.
- Existing first-party logs and sessions with no external declarations remain byte-compatible and readable, and `SESSION_FORMAT_VERSION` remains unchanged.
- The generated persistence catalog, Session and Persistence package documentation, TypeScript public exports, Python SDK generated expectations, and keyless snapshots include the declaration event and new diagnostics.
- `pnpm run verify-persistence-catalog`, targeted Session/Persistence tests, JSONL/SQLite differential tests, `pnpm run test:docs`, `pnpm run doc-sync`, and repository lint all pass.

## Consequences

- A trusted package can lie about its package name or compatibility. This registry provides deterministic ownership and fail-closed recovery, not package-signature verification; installation trust remains the Bundle manager's responsibility.
- The two synchronous appends expose the declaration to in-process observers before the target event. The handle must prevalidate the target and observers must already tolerate any committed log-only event independently; no asynchronous operation or external side effect occurs between the two appends.
- Historical compatibility registrations can become false claims after a plugin refactor. External producers must test cold folds for every historical tuple they register; DSH cannot infer payload compatibility from event names.
- Prefix-dependent suffix admission can add one full-log read when the declaration is outside the suffix. This preserves correctness and affects only sessions using external events; a later indexed declaration table may optimize it without changing the log contract.
- The new public API becomes a long-lived extension boundary. It must stay limited to required log-only events until a real optional-event consumer supplies a separate, reviewable semantic contract.
