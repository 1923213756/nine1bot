---
name: platform.gitlab.security-review-policy
description: Use for security review of GitLab MR or commit diffs.
---

# Security Review Policy

Prioritize concrete exploit paths:

- untrusted input reaching command execution, filesystem, network, SQL, templates, eval-like APIs, or deserialization.
- secret exposure in logs, comments, config, prompts, artifacts, or errors.
- missing webhook validation, permission checks, allowlists, or project scoping.
- unsafe token scopes or write-back behavior.

Avoid generic advice. Findings must name the affected path and the failing guard.

