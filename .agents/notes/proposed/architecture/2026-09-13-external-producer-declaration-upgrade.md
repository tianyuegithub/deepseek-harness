# Agent Note: Declaration upgrades for external session event producers

Status: proposed

English | [中文](2026-09-13-external-producer-declaration-upgrade.zh.md)

Related implemented contract: [Durable external session event producers](../../implemented/architecture/2026-08-29-durable-external-session-event-producers.md)

## Problem

The first version of durable declarations pins each session, per producer, to **exactly one declaration**: on append, any existing same-producer declaration in the log must equal the writing handle's tuple (producer, version, eventTypes) exactly, or a conflict error is thrown. Reading likewise requires one exact active registration per persisted declaration.

That decision achieves every v1 goal — durable vocabulary identity, fail-closed reading, no silent semantic loss — but it also means: **once a trusted plugin ships a new version (new event vocabulary), every session created by its own previous version is permanently write-frozen**. New sessions declare the new version from their first write and are unaffected; any state-changing write to an old session fails. Because the session log is the external product's only durable fact source (needs, runs, retained scenes, authorizations live there), this turns upgrades into "abandon all in-flight work", not a compatibility inconvenience.

The boundary has been hit in real use. After a plugin upgrade, an external product's first state-changing write to an existing session was rejected:

```text
Error: session "session-…" has a conflicting declaration for external producer "dsh-pactflow"
```

Reading (through read-only compatibility registrations) works fine; no write path exists; neither host nor plugin offers a declaration-upgrade mechanism. The v1 Agent Note explicitly excluded "schema-driven migration" and "compatibility version ranges" from the first contract, but it did not exclude **explicit declaration upgrades** as such — this proposal adds that path while keeping v1's fail-closed invariants intact.

## Decision

### A declaration sequence per producer, strictly version-ordered

Generalize "one declaration per producer per session" to "a position-ordered declaration sequence". For the same producer, a subsequent declaration event must satisfy:

1. **Strictly higher version**: the new version is strictly greater, in semver ordering, than every existing declaration version for that producer in this session. Downgrades, or the same version with a different set, remain hard conflicts with the current error.
2. **Vocabulary superset**: the new `eventTypes` must contain every event type of the superseded declaration. Vocabulary only grows; at every position each event type still has exactly one owner, so `assertEventsSupported`'s position-wise admission needs no notion of "ownership that disappeared".
3. **Triggered through the new version's handle**: the upgrade is not a separate core API. The trusted plugin holding the higher-version registration calls `handle.append()` as usual; when the appender finds the producer's latest declaration in the log supersable by the current handle, it **synchronously** appends the new declaration event first, then the target event — the same two-append structure as v1's first declaration, with no async gap in between. The core performs structural validation, monotonicity validation and append ordering; the trust boundary is identical to v1 (trusted host plugins write, the core verifies).

An equivalent declaration (same version and set) keeps the current behavior: reuse the existing declaration, do not write another one.

### Read admission takes effect per segment

`PersistenceCoordinator.assertEventsSupported()` generalizes "one active declaration" to "an ordered declaration sequence per producer":

- Every persisted declaration must have an **exact active registration** in the registry (per-declaration `requireReadable`, same as v1; read-only compatibility registrations satisfy this). Any missing one still fails with `SessionFormatUnsupportedError`, and the diagnostic names the producer and version.
- Each declaration admits its own event types from its position onward; an external event of some type appearing before its declaration is still rejected.
- Suffix-read prefix fallback is unchanged: when a declaration lies outside the returned range, read the full prefix first, then decide.

This needs no new event type and changes neither the envelope nor `SESSION_FORMAT_VERSION`: an upgrade simply writes another v1 `session/external-event-producer` event. Older DSH builds encountering a multi-declaration log fail closed under the existing unknown/unsupported rules, which is the right direction.

### Plugin-side obligations (the external producer contract)

- Keep an active read-only compatibility registration for every historical tuple whose sessions must stay readable, and maintain a cold-fold test per historical tuple — both are existing v1 obligations; this proposal adds none.
- The write side still holds a single current-version handle; upgrade semantics are enforced by the core during append, and the plugin never rewrites logs or writes through multiple versions in parallel.

## Alternatives considered

**Mutating the session header, or adding version tags to the envelope.** Rejected again for the v1 reasons: the header is immutable, and envelope changes would needlessly trigger a format-version migration; declaration-segment semantics already provide the needed per-segment interpretation.

**Allowing arbitrary re-declaration (no monotonicity, no superset requirement).** Rejected: downgrades and vocabulary retreat would make "what interpretation this log currently requires" position-dependent guesswork; monotonic upgrades plus supersets keep deterministic interpretation trivial.

**Skipping historical declarations whose registration is absent at read time.** v1 rejected "skip events when the producer is missing"; this proposal does not reopen that: silent skipping is precisely the semantic loss the declaration system exists to eliminate.

**Product-side self-healing (forked persistence, dual-writing new sessions, copy migration).** Rejected: this is v1's rejected "patch the persistence coordinator in every external product" — it forks the trust boundary, breaks profile portability, and creates a second fact source.

**A dedicated core command/API for upgrades.** Rejected: an extra authorization surface and call-ordering questions, while the trusted plugin's append path already carries everything required; v1's principle that the handle is the only supported write path does not need a second entrance.

## Testing

- Core unit tests: the upgrade validity matrix (higher version + superset passes; downgrade, same version with a different set, vocabulary shrink, and cross-producer type contention all rejected); structural validation and canonical ordering of multi-declaration logs.
- Append contract: an upgrade writes declaration event + target event as two synchronous appends; equivalent declarations are not rewritten; a failed validation leaves the log untouched; a second upgrade, and an equivalent append after an upgrade, both behave correctly.
- JSONL and SQLite cold reads: a log with two upgrades restores fully when every historical registration is present; any missing historical registration fails with `SessionFormatUnsupportedError` and diagnostics naming the producer/version; first-party logs and sessions without external declarations stay byte-compatible.
- Suffix reads: with a declaration outside the range, fall back to the prefix and decide identically to full reads (including multi-declaration logs).
- All existing v1 tests keep passing; `pnpm run verify-persistence-catalog`, `pnpm run test:docs`, `pnpm run doc-sync` and lint pass; the generated persistence catalog and session docs are updated in the same change.

## Consequences

- Reading a log that may contain upgrades requires registrations for **every version the log has used** (including read-only compatibility registrations). Registry footprint grows with the number of shipped versions; this is the direct price of the "successful read means full restoration" invariant.
- The grow-only vocabulary constraint means an external event type, once shipped, cannot be retracted from later declarations; retiring a type requires the product to guarantee it no longer writes it while keeping the declaration for historical segments.
- If a plugin is downgraded below a session's highest declared version without carrying the historical read-only registrations, that session becomes unreadable — fail-closed in the same direction as v1, but the upgrade path makes such states easier to reach, so diagnostics must name the exact missing tuple.
- An upgrade write, like v1's first declaration, is two synchronous appends; the observer and handle pre-validation obligations are unchanged.
