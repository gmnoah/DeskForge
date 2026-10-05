# DeskForge

本地优先的 macOS 桌面工作 Agent。界面在沙箱里，审批、策略和密钥留在主进程，模型和工具分别在独立进程里跑。文件和 Shell 只作用于你选中的工作区，不会把授权根默认设成磁盘根目录 `/`。

DeskForge 是独立项目，不是 WorkBuddy，也不是腾讯的产品。桌面实现改编自 [OpenWorkbuddy](https://github.com/chenin0931/OpenWorkbuddy)（MIT，Copyright (c) 2026 OpenWorkbuddy contributors）。详见 `NOTICE`。

DeskForge is an independent local-first macOS work agent. It is not WorkBuddy and it is not a Tencent product.

## 模型

设置里选择 OpenAI 兼容接口，并填写可修改的 `baseUrl`：

| 预设 | 默认地址 | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-auto` |
| 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 自定义 | 由你填写 | 由你填写 |

API Key 在设置里写入。macOS 上由系统钥匙串（Electron `safeStorage`）加密后保存在本机数据库，界面不能读回。密钥框留空表示保留已有密钥。加密不可用时保存会失败，不会把明文写入 SQLite。

## 如何在 macOS 开发运行

需要 macOS、Node.js 22.14 或更新版本，以及 pnpm 10.33。

```bash
corepack enable
corepack pnpm install
corepack pnpm dev
```

常用检查：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
DESKFORGE_SMOKE=1 corepack pnpm smoke
```

`pnpm smoke` 会先构建，再按当前 CPU 架构为 Electron 重建 `better-sqlite3`，然后以 `DESKFORGE_SMOKE=1` 启动。窗口加载完成后标准输出出现 `deskforge-ready`，进程退出。`better-sqlite3` 不能同时服务系统 Node 和 Electron：跑完 smoke 后再执行 `pnpm test`，测试的 pretest 会把它重建回 Node。

在 macOS 上打未签名包（不包含 Chrome 扩展或本机消息宿主）：

```bash
corepack pnpm package
```

这会执行 `electron-builder --mac`，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。产物在 `outputs/release/`。当前脚本按 x64 重建 `better-sqlite3`。Apple Silicon 上如需 arm64 包，在 `apps/desktop` 里改用 `pnpm package:mac:signed:arm64` 前，先确认本机有对应的 Electron 重建环境；未签名包仍会被 Gatekeeper 拦截，需要在「隐私与安全性」里手动放行，或使用自己的 Developer ID 走 `package:mac:signed:*`。

### 常见失败

- `pnpm install` 没编译 `better-sqlite3`：确认 `pnpm-workspace.yaml` 里的 `onlyBuiltDependencies` 包含 `better-sqlite3` 和 `electron`，然后重新安装。
- Electron 启动报 `NODE_MODULE_VERSION` 或架构不匹配：`better-sqlite3` 需要按 Electron 重建。`pnpm smoke` 会按当前架构做这件事；也可以在 `apps/desktop` 执行 `pnpm rebuild:electron:arm64` 或 `pnpm rebuild:electron:x64`。跑测试前由 pretest 重建回 Node。
- 打开 `.app` 被 Gatekeeper 拒绝：未签名包的预期结果。开发时用 `pnpm dev`，分发前再签名并公证。
- 保存 API Key 提示系统安全存储不可用：当前环境没有可用的钥匙串加密。不要改成明文落库；在已登录的 macOS 图形会话里再保存。
- `pnpm package` 在 Linux 上失败：macOS 包需要在 macOS 上构建。

## 示例 Skills

`skills/examples/workspace-summary`（工作区总结）和 `skills/examples/safe-shell`（安全 Shell 使用说明）会随应用安装到本机 Skills 目录。说明只覆盖当前工作区，并要求 Shell 走审批。

## 路线

P0 是这台 macOS Electron 应用：工作区白名单、审批、审计、SQLite 会话、按需加载工具，以及上面的模型预设。

P1：把模型请求的密钥留在主进程、崩溃后恢复未完成审批、签名并公证的 macOS 包。

P2 尚未实现，也不在本仓库的当前范围内：飞书、企业微信、钉钉、无界面服务、Windows。
