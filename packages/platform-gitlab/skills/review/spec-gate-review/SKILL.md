---
name: platform.gitlab.spec-gate-review
description: Use to decide whether a GitLab review has enough product and technical context to proceed.
---

# Spec Gate Review

Classify the review context as:

- ready: enough information exists to review changed behavior.
- partial: review can proceed with explicit assumptions.
- blocked: missing context would make review misleading.

Do not block merely because a repository lacks formal spec documents. Block only when the MR purpose, expected behavior, or acceptance criteria cannot be inferred from the MR description, linked context, commit messages, and changed code.

