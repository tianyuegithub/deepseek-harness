# Agent Note: Per-run Subagent workspace authority

Status: implemented

English | [中文](2026-08-30-per-run-subagent-workspace.zh.md)

## Problem

Trusted workflow consumers need to start children for one parent in distinct Git worktrees while preserving one workspace fact for process startup, filesystem and shell policy, persistence, and recovery. Asking the model to change directory cannot establish that fact because the child `SessionHeader` and provider process initialization would still use another workspace.

A per-run workspace changes file and process authority. It must therefore be an explicit provider capability, must fail before publication when unsupported or unusable, and must become the one child Session workspace fact consumed by tools, policy, process adapters, and persistence. A deployment-wide configured directory remains an operator restriction and cannot be silently bypassed by one caller.

## Decision

`SubagentStartRequest` carries optional `cwd`, and `SubagentCapabilities` carries a required `cwd` member. `SubagentRuntime.start()` requires the selected provider to advertise the capability whenever the request supplies `cwd`. The field remains a trusted same-process API input and is not part of the model-facing `subagent` tool schema.

Providers that advertise the capability resolve a child workspace before publication. An absolute accessible directory supplied by the request takes precedence over the parent Session workspace only when the provider has no configured `cwd`. When a provider has a configured `cwd`, a different requested directory fails instead of overriding or ignoring the deployment restriction; an equal directory is accepted. Providers validate the resolved directory through their existing local or remote workspace admission path.

In-process spawn and fork providers stamp the resolved directory into the child `SessionHeader.cwd` before the Session becomes visible. Out-of-process ACP, Codex, Claude Code, and DSH SDK providers pass the same resolved directory to their process and remote-session initialization. The request remains the parent-side authority for a remote run; a provider does not invent a second workspace field in the result.

## Alternatives considered

**Ask each Worker to execute `cd`.** Rejected because prompt compliance is not an authority mechanism, shell and filesystem defaults retain the parent workspace, and the persisted child identity records the wrong directory.

**Create a synthetic parent Agent whose header names the worktree.** Rejected because it forges ownership and lineage, bypasses the Subagent Runtime's parent checks, and creates a live object with no legitimate Session lifecycle.

**Add a PactFlow-only provider wrapper.** Rejected because every provider already owns workspace resolution and child publication. Reimplementing those lifecycles in an external product would create inconsistent cancellation, persistence, and policy behavior.

**Let a request always override provider configuration.** Rejected because provider configuration may pin execution to an operator-approved sandbox or checkout. Per-run selection cannot expand that deployment authority.

## Testing

Capability tests reject unsupported `cwd` before provider start. Shared workspace tests cover absolute-directory admission, request precedence, configured-directory conflict, parent fallback, and invalid paths. Spawn, ACP, Codex, Claude Code, and DSH SDK provider tests observe the selected directory through the published child Session or real provider startup protocol; omission tests preserve prior behavior. Type checking requires every provider and test provider to declare the new capability.

## Consequences

Trusted Host plugins can select any directory already available to the DSH process. This decision does not grant model callers a new field and does not replace sandbox or filesystem policy; deployments continue to confine the process itself.

Adding one capability flag updates every provider and test provider. Missing declarations must fail compilation rather than defaulting to false, so a future provider cannot accidentally accept or ignore the request.
