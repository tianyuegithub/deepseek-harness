# Agent Note: Managed browser sessions

Status: proposed

English | [中文](2026-10-07-managed-browser-sessions.zh.md)

## Problem

A platform gateway cannot create or revoke native browser authentication through a supported Host API. Parsing launch output or credential records couples the platform to private authentication details.

## Proposal

Connection will expose a Host-only browserSessions API. BrowserAuth will own a version-2 signed cookie and an in-memory pending, active, or terminal record. Omitted managedBrowserSessions config disables creation and verification; explicit port and maxRecords enable a 127.0.0.1 bridge in the existing profile. No browser RPC exposes the API.

Creation binds a UUID operation, activation generation, canonical HTTPS origin, and absolute expiry. Identical live requests return the same credential; changed inputs conflict. A pending record must activate within 60 seconds. Revoke and expiry reject authentication immediately. Terminal records remain until the later of their absolute expiry and five minutes after termination; all records count toward capacity and no retained record is evicted. Expired creation inputs are rejected after cleanup.

Every activation uses a random generation. Disposal rejects managed credentials before awaiting listener shutdown. A reload invalidates all version-2 cookies even when the persistent signing secret survives. Version-1 browser authentication keeps its existing behavior.

The loopback bridge rejects foreign Host, Origin headers, non-loopback peers, oversized or malformed JSON, and unknown fields. It does not establish platform identity. The platform adapter owns its signing key outside the Host process, validates instance ownership, and removes browser-supplied native cookies before injecting one managed cookie. Deployment must not publish the bridge port or share process namespaces.

Managed Web activation prints only clean root addresses and suppresses automatic native browser handoff. The ordinary Web activation keeps its token exchange; platform deployments must opt into managed Connection before the runtime announces readiness.

## Alternatives considered

**Launch-token extraction:** rejected because URL credentials and output parsing provide no supported per-session revocation.

**Persistent credential mutation:** rejected because the private payload does not expose session creation and deleting a record does not revoke the loaded signing secret.

**Public browser RPC:** rejected because session minting belongs to the Host integration caller rather than browser clients.

## Acceptance criteria

Tests must preserve ordinary authentication, reject inactive, expired, revoked, disabled, foreign-authority, and reloaded credentials, and verify idempotency, capacity, and bridge request fences. Profile lifecycle tests must prove listener release. Built artifacts and an isolated platform instance must prove the real create, activate, access, and revoke path before integration acceptance.

## Risks

Processes in the same Pod can call the loopback service for their own Host; this design does not isolate malicious user code from its own home. The platform gateway, network policies, secret mounts, and cookie stripping remain separate required evidence. Source tests alone do not prove deployment or browser acceptance.
