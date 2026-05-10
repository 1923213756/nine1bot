---
name: platform.gitlab.verification-matrix
description: Use to plan minimal QA checks for GitLab review findings.
---

# Verification Matrix

For each meaningful behavior change, identify the smallest useful verification set:

- existing automated test that should cover it.
- missing test worth adding.
- manual reproduction path when automation is unavailable.
- residual risk if verification could not run.

Do not request broad test suites unless the changed files touch shared runtime, platform registration, config loading, or security-sensitive code paths.

