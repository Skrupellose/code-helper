# GitHubActions发布自动化

## 下一步建议

当前默认主线是先建立只检查不发布的 CI，再增加手动 npm 发布 workflow，最后补充 README 和长期发布规则。发布 workflow 只发布当前 `package.json` 版本，不自动改版本、不自动创建 tag。

## 目标与约束

- PR 和 `main` push 自动运行项目验证。
- npm 发布由 GitHub Actions 手动触发，避免普通 push 自动发布。
- npm 发布优先使用 Trusted Publishing / OIDC，不引入长期 npm token。
- 发布前必须运行测试、协作检查和打包 dry-run。
- 不在本任务中实际发布 npm，不推送远端。

## 执行计划

| 子任务 | 已完成 | 未完成 | 备注 |
| --- | --- | --- | --- |
| CI 检查 | 新增 `.github/workflows/ci.yml`，覆盖 Node.js 20 和 22 | 无 | 状态：已完成。后续检查点是 PR 和 main push 都应运行。 |
| npm 手动发布 | 新增 `.github/workflows/npm-publish.yml`，使用手动确认、OIDC 权限和 provenance 发布 | 无 | 状态：已完成。后续检查点是在 npm 包设置中配置 trusted publisher。 |
| 文档同步 | README 和长期规则已补充 Actions 与发布说明 | 无 | 状态：已完成。后续检查点是发布前仍需人工确认版本。 |
| 验证 | `npm test`、`npm run check`、`npm pack --dry-run` 已通过 | 无 | 状态：已完成。远端 Actions 需推送后验证。 |

## 验收标准

- CI workflow 不含发布权限，只做检查。
- npm 发布 workflow 具备 `id-token: write`，并使用 `npm publish --provenance`。
- 发布 workflow 必须手动输入 `publish` 才会继续。
- README 说明 trusted publisher 的 workflow 和 environment 配置。
- 本地验证通过。
