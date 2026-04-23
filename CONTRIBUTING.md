# Contributing to Nine1Bot

Thanks for your interest in contributing to Nine1Bot.

欢迎参与 Nine1Bot 的开发与改进。

You can contribute in English or Chinese.

你可以使用英文或中文提交 Issue 和 Pull Request。

## Ways To Contribute / 贡献方式

- Report bugs or regressions. / 反馈缺陷或回归问题。
- Suggest new features or workflow improvements. / 提出新功能或工作流改进建议。
- Improve documentation, examples, or translations. / 完善文档、示例或翻译。
- Submit focused code changes with clear verification steps. / 提交范围清晰、带验证说明的代码改动。

## Before You Start / 开始前

- Search existing issues and pull requests before opening a new one. / 新建前先搜索现有 Issue 和 PR，避免重复。
- Keep each change focused on one problem or one feature. / 每次改动尽量只解决一个问题或一个功能点。
- If your change touches UI or workflow behavior, include manual verification steps. / 涉及 UI 或交互流程时，请附上手动验证步骤。
- Do not commit secrets, local credentials, or machine-specific overrides. / 不要提交密钥、本地凭证或机器相关配置。

## Project Layout / 项目结构

- `packages/nine1bot`: CLI, local server, config, launcher, tunnel logic.
- `web`: Vue-based web UI.
- `packages/browser-extension`: browser extension for browser control.
- `packages/browser-mcp-server`: browser MCP integration layer.
- `scripts`: release, packaging, and smoke-test scripts.
- `opencode`: upstream dependency layer; only change it when the fix clearly belongs there. / 上游依赖层，只有当修复明确属于这里时再改动。

## Local Development / 本地开发

From the repository root:

在仓库根目录可使用以下命令：

```bash
# Start the main app in development mode
bun run dev

# Start the web UI dev server
bun run web

# Build the web UI
bun run build:web

# Run the packaged app flow used for manual verification
bun run dev:test
```

Package-specific checks:

按模块执行检查：

```bash
# Typecheck the main package
cd packages/nine1bot && bun run typecheck

# Build and typecheck the browser extension
cd packages/browser-extension && bun run build
cd packages/browser-extension && bun run typecheck
```

If your change touches only one area, run the checks that match that area.

如果你的改动只影响某一部分，优先运行对应模块的检查即可。

## Issues / Issue 反馈

- Use the bug report form for reproducible defects, crashes, regressions, or incorrect behavior. / 可复现的缺陷、崩溃、回归或行为错误，请使用 Bug 模板。
- Use the feature request form for new capabilities, UX improvements, or workflow ideas. / 新能力、体验优化或工作流建议，请使用 Feature Request 模板。
- Include version, installation method, operating system, reproduction steps, expected result, actual result, and logs or screenshots when possible. / 尽量提供版本、安装方式、操作系统、复现步骤、预期结果、实际结果，以及日志或截图。

## Pull Requests / Pull Request 说明

- Follow the existing PR template in `.github/PULL_REQUEST_TEMPLATE.md`. / 请按现有 PR 模板填写说明。
- Prefer Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. / 提交信息建议沿用 `feat:`、`fix:`、`docs:` 等 Conventional Commit 风格。
- Keep pull requests small enough to review. / PR 尽量保持可审查的粒度，不要把无关改动混在一起。
- Link related issues when relevant. / 有关联 Issue 时请显式关联。
- Add screenshots for visible UI changes. / 可见 UI 变化请附截图。
- Document manual test steps for behavior changes. / 行为变更请补充手动验证步骤。

## Pre-Submission Checklist / 提交前检查

- Relevant build or typecheck commands have been run. / 已运行相关构建或类型检查命令。
- Documentation or config examples were updated if behavior changed. / 若行为或配置有变化，已同步更新文档或示例。
- Local-only files are not included in the diff. / diff 中未混入本地临时文件。
- The change is scoped and ready for review. / 改动范围清晰，已经可以进入审查。
