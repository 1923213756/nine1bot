# Nine1Bot GitLab Platform Adapter

This package is the reference layout for third-party platform integrations.
Platform-specific parsing, page normalization, context blocks, template
contributions, and resource contributions belong here instead of in the
Nine1Bot Runtime core.

## Boundary

- Browser extension code should collect DOM facts and call this package.
- Web code may use browser-safe helpers from `@nine1bot/platform-gitlab/browser`.
- Nine1Bot product startup registers the runtime adapter from
  `@nine1bot/platform-gitlab/runtime`.
- OpenCode / Nine1Bot Runtime core must only depend on the generic platform
  adapter registry, not this package directly.

## Code Review Plugin

See [GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md](./GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md)
for the initial design of the `@Nine1bot` merge request review flow. The design
keeps GitLab webhook parsing, MR context loading, review orchestration, and
comment publishing inside this platform package while exposing only generic
context/resource contributions to the controller and runtime.

## Adding Another Platform

Use this package as the copyable example:

1. Create `packages/platform-<name>`.
2. Keep pure URL/page parsing in the platform package.
3. Export browser-safe helpers separately from runtime adapter helpers.
4. Register the adapter from the Nine1Bot product layer.
5. Add tests in the platform package for parser, payload, templates, and
   resources.
