---
name: platform.gitlab.pm-risk-routing
description: Use to choose which custom subagents should be created for a GitLab review run.
---

# PM Risk Routing

Route by blast radius:

- Security subagent: auth, access control, secrets, dependency loading, command execution, network boundaries, user data, persistence, webhook verification.
- QA subagent: behavior changes, tests, migrations, release configuration, failure handling, cross-platform paths.
- Frontend subagent: UI, layout, accessibility, state, browser integration, user-facing text.
- Technical architecture subagent: shared contracts, runtime boundaries, plugin APIs, orchestration, persistence, config.
- Developer subagent: implementation patches only when the run allows code changes.

Use `failureMode: abort-run` for PM/spec gates that are required. Use `ignore` or `fallback` for optional QA/Security/Frontend subagents and report timeouts in the final comment.

Default routing should be conservative:

- Small MR with low-risk local changes: PM can review directly without subagents.
- Runtime/API/config/persistence changes: include technical architecture.
- User-facing frontend changes: include frontend.
- Behavior or test-sensitive changes: include QA.
- Auth, token, webhook, command, network, dependency, storage, or data exposure changes: include security.

