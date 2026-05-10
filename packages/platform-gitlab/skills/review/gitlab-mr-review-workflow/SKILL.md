---
name: platform.gitlab.gitlab-mr-review-workflow
description: Use for GitLab merge request review runs triggered by @Nine1bot comments or merge request webhooks.
---

# GitLab MR Review Workflow

Treat the GitLab merge request as the source of truth for scope. Review only the included diff manifest and provided repository context.

This is a read-only review workflow by default. Do not edit files, run fix scripts, or turn the review into a general implementation task unless the PM input explicitly sets `fixMode=true`.

Stage order:

1. discovery: identify changed files, risk areas, evidence, assumptions, and blocked conditions.
2. spec: decide whether available requirements, design notes, and task context are enough to review safely.
3. implementation: dispatch focused custom subagents when architecture, frontend, backend, QA, or security review is needed.
4. verification: merge structured findings and ask PM to decide severity, conflicts, and release risk.
5. fix: only propose or apply minimal patches when the run explicitly allows code changes.
6. closed: render a concise GitLab summary and include skipped files, fallback inline comments, and timed-out agents.

Never invent findings outside the diff. If the diff is blocked, truncated, or empty after filters, stop and report the blocked state.

The PM coordinator must finish with one fenced JSON block tagged `GITLAB_REVIEW_RESULT`. The JSON must match the ReviewStageResult schema from `platform.gitlab.review-finding-schema`.

