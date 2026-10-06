# 参与 DeskForge 开发

感谢你愿意参与！下面是最小必要的约定。

## 环境

- Node.js 22.14+，pnpm 10.33（`corepack enable`）
- macOS 用于运行和打包桌面应用。Linux 可以跑 typecheck、测试，以及 `xvfb-run -a pnpm smoke`（需先安装 `make`、`g++`）

```bash
pnpm install
pnpm dev          # 启动桌面应用
pnpm typecheck
pnpm test         # pretest 会把 better-sqlite3 重建为 Node 版本
```

## 提交前

1. `pnpm typecheck` 和 `pnpm test` 必须通过，CI 会在 push / PR 时再跑一遍。
2. 改到模型请求时，在 `apps/desktop/src/workers/provider-streaming.test.ts` 补夹具测试。测试请按服务商文档构造响应，**不要使用真实 Key**。
3. 新增的用户可见文案用中文，并且要说清楚用户下一步该做什么。错误分类集中在 `packages/core/src/model-errors.ts`。
4. 代码注释简短。沿用所在文件的语言（现有代码注释以英文为主）。
5. 一个 PR 只做一件事，按逻辑拆分提交，提交信息写清楚改了什么。

## 安全底线

- **绝不提交密钥**：包括 `.env`、日志、测试夹具里的真实 Key。测试里只用明显伪造的值。
- 文件和 Shell 能力必须受工作区白名单约束。新工具要接入 `packages/core/src/policy.ts` 的风险分级。
- 密钥不能进入工具参数、审计日志或模型上下文。

## 品牌与许可

- 保留 `NOTICE` 中对 OpenWorkbuddy（MIT）的署名，以及 DeskForge 品牌。
- DeskForge 是独立项目。不要在代码、文档或界面中声称与腾讯或 WorkBuddy 有任何关联。
- 提交代码即表示你同意以 MIT 许可发布。
