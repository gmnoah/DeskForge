# DeskForge 现有仓库来源基线

记录日期：2026-10-06。当前仓库 `ad95e8d`；移植基线 `7972bd6`（提交信息明确记录从 OpenWorkbuddy 移植）。本表服务于新程序的独立重建和现有版本的许可交付；它不是版权归属结论。

首批重建已生成 [逐文件来源线索快照](rebuild/LEGACY_FILE_INVENTORY.csv)，覆盖 207 个已跟踪代码、测试、资源、配置与许可文件，包含工作树摘要。生成方法为 `python3 docs/rebuild/capture_provenance.py`。每项仍标记 `pending`，Git 来源线索不能代替作者与版权复核。新实现另见 `independent/SOURCE_LEDGER.md`。

## 初步分类

| 模块 | 当前路径 | 来源状态 | 新程序处理建议 |
| --- | --- | --- | --- |
| 桌面进程与 IPC | `apps/desktop/src/main/index.ts`、`ipc-api.ts`、`worker-bridge.ts`、`packages/contracts` | 移植基线上持续修改 | 从新架构规格定义进程通信；旧代码只作行为参考，不复制实现 |
| 工具策略与执行 | `apps/desktop/src/main/tool-broker.ts`、`packages/core/src/policy.ts`、`apps/desktop/src/workers/runner-security.ts` | 移植基线上持续修改 | 独立定义权限模型，安全测试先行；严格核查路径、审批和外发边界 |
| Agent 与模型请求 | `apps/desktop/src/workers/agent-host*.ts`、`model-request-pipeline.ts` | 移植基线上持续修改；另有第三方 Pi 依赖 | 按公开模型协议重新设计运行时；第三方 Pi 来源另记 |
| 数据与恢复 | `apps/desktop/src/main/database.ts`、`run-coordinator.ts` | 移植基线上持续修改 | 定义新数据格式与导入器；旧 SQLite 只作为迁移输入 |
| 用户界面 | `apps/desktop/src/renderer/src` | 移植基线上持续修改，部分功能新建 | 依据新用户场景独立设计；图标、样式、文案一并核查 |
| 本地知识与会话搜索 | `apps/desktop/src/main/knowledge`、相关会话搜索文件 | 移植后新增功能 | 可以复用产品需求和用户反馈，不直接移植现有实现 |
| MCP 与 Skill 导入 | `apps/desktop/src/main/mcp-service.ts`、`skill-import.ts` 等 | 移植后新增或扩展 | 新程序 MVP 后按需求重建，使用公开协议文档 |
| 第三方软件 | `pnpm-lock.yaml`、各 `package.json` | 各自独立许可 | 编制实际发行包的第三方许可清单，不视作 OpenWorkbuddy 代码 |

## 核对方法与限制

当前路径下，移植提交中的 113 个 `.ts/.tsx/.css` 源文件均仍存在；67 个在该路径的 Git 内容未改变，46 个已改变；此外新增 57 个源文件。这只是路径和 diff 统计。改变的文件仍可能包含移植内容；新增文件也需要来源审查。新程序的独立性应由其独立规格、实现过程记录、依赖清单和发布包审计共同证明。

复核命令：

```bash
git show --format=fuller --no-patch 7972bd6
git diff --name-status 7972bd6 HEAD
git diff --numstat 7972bd6 HEAD -- apps/desktop/src packages
rg -n -i 'openworkbuddy|workbuddy|copyright|license' . --hidden -g '!.git/**' -g '!pnpm-lock.yaml'
```

下一步：固定具体上游源码版本和许可文本，逐文件登记来源与权利人，再由发布负责人复核。新程序应使用单独的 `SOURCE_LEDGER.md` 记录每个新文件的独立来源。
