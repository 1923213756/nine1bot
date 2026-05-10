---
name: platform.gitlab.gitlab-comment-rendering
description: Use to render GitLab review results into concise merge request or commit comments.
---

# GitLab Comment Rendering

Render for maintainers scanning a GitLab MR:

- lead with blocked status or high-severity findings.
- include skipped files and timeout warnings.
- keep top-level summary short.
- use inline comments only after code-side hunk validation.
- if inline validation fails or GitLab returns 400, fall back to a top-level Markdown note with file and line context.

Never hide blocked diff conditions behind a normal success summary.

