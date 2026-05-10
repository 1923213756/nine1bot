---
name: platform.gitlab.gitlab-commit-review-workflow
description: Use for narrow GitLab commit review runs triggered from commit comments.
---

# GitLab Commit Review Workflow

Review the target commit in a narrow scope. Prefer direct changed-line feedback and avoid broad architectural conclusions unless the commit clearly touches shared production behavior.

Commit review may skip spec-gate work when the request is only asking for localized feedback. Security and QA review still apply when the diff touches auth, permissions, storage, networking, dependency execution, runtime configuration, release scripts, or user data.

