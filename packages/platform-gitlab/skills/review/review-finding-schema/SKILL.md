---
name: platform.gitlab.review-finding-schema
description: Use to produce structured GitLab code review findings and the final GitLab review result.
---

# Review Finding Schema

Use this skill whenever a GitLab review agent or PM coordinator emits findings.

## Final Result Contract

The PM coordinator final answer must be exactly one fenced JSON block. The first content line inside the fence must be `GITLAB_REVIEW_RESULT:`.

```json
GITLAB_REVIEW_RESULT:
{
  "stage": "closed",
  "status": "ok",
  "summary": "Concise review conclusion grounded in the supplied diff.",
  "findings": [],
  "nextActions": []
}
```

Required fields:

- `stage`: always `closed` for the final PM result.
- `status`: one of `ok`, `blocked`, `failed`.
- `summary`: short human-readable conclusion.
- `findings`: array of finding objects, empty when no concrete issues are found.
- `nextActions`: array of short strings, empty when no follow-up is needed.

Do not wrap the result in another object. Do not add Markdown prose outside the JSON fence.

## Finding Object

```json
{
  "title": "Short finding title",
  "body": "Evidence, impact, and suggested change.",
  "severity": "major",
  "category": "correctness",
  "file": "src/example.ts",
  "oldLine": 12,
  "newLine": 18,
  "suggestion": {
    "replacement": "return validate(input)",
    "confidence": "high"
  },
  "source": "pm-coordinator"
}
```

Required finding fields:

- `title`
- `body`
- `severity`

Optional finding fields:

- `category`
- `file`
- `oldLine`
- `newLine`
- `suggestion`
- `source`

Allowed severities: `info`, `minor`, `major`, `critical`, `blocker`.

Allowed categories: `correctness`, `security`, `testing`, `performance`, `maintainability`, `frontend`, `architecture`, `docs`, `config`.

## Suggestion Rules

Use `suggestion` only for a small, local replacement that can be applied to a changed diff line. The publisher may render it as a GitLab suggestion block only after inline position validation passes.

`suggestion` fields:

- `replacement`: replacement code only. Do not include markdown fences.
- `confidence`: `low`, `medium`, or `high`.

Do not include a suggestion when:

- the location is uncertain.
- the fix spans multiple files or multiple hunks.
- the fix needs product, security, or architecture approval.
- the replacement includes markdown fences.

When in doubt, put the recommendation in `body` instead of `suggestion`.

## Evidence Rules

Only include `file`, `oldLine`, or `newLine` when the location is grounded in the supplied GitLab diff evidence and review line map.

Never guess line numbers. Use the `Review line map for file/newLine/oldLine fields` rows when present:

- added lines use `newLine`.
- deleted lines use `oldLine`.
- unchanged context lines inside a hunk may use `newLine`; the publisher can map it to the matching `oldLine`.

If the exact diff hunk line is uncertain, omit line fields and let the publisher create a top-level summary finding.

Do not create findings for:

- style-only preferences
- generic best practices without diff evidence
- files skipped by filters
- behavior outside the supplied MR or commit diff

## Status Selection

Use `ok` when review completed, even if findings exist.

Use `blocked` when the diff is too large, truncated, overflowed, empty after filters, or otherwise lacks enough evidence to review.

Use `failed` when the review workflow itself failed and no reliable review conclusion can be produced.

## Minimal Valid Outputs

No findings:

```json
GITLAB_REVIEW_RESULT:
{
  "stage": "closed",
  "status": "ok",
  "summary": "No concrete issues were found in the supplied diff.",
  "findings": [],
  "nextActions": []
}
```

Blocked:

```json
GITLAB_REVIEW_RESULT:
{
  "stage": "closed",
  "status": "blocked",
  "summary": "Review was blocked because the supplied GitLab diff was truncated or too large.",
  "findings": [],
  "nextActions": ["Split the MR or request a manual review for the omitted diff."]
}
```
