# DeskForge

DeskForge is a local-first macOS work agent. It is not WorkBuddy and not a Tencent product.

DeskForge 是一个本地优先的 macOS 桌面工作代理。模型可以提出动作，但不能自己批准动作。界面跑在沙箱里，文件和 Shell 只在你点头之后，由单独的工具进程在工作区内执行。

它不是 WorkBuddy，也不是腾讯的产品。进程划分、风险策略、哈希链审计、按需加载能力和 `SKILL.md` 这些想法，参考了开源项目 [OpenWorkbuddy](https://github.com/chenin0931/OpenWorkbuddy)（MIT）。DeskForge 重新实现了自己的代码，详见 [NOTICE](NOTICE)。

## 它能做什么（P0）

- 只做 macOS Electron 桌面应用
- 选择一个工作区文件夹。文件系统根目录 `/` 不能当作工作区，也没有「全盘访问」默认值
- 用 OpenAI 兼容的 `baseUrl` 调用模型。预置 DeepSeek、Kimi、通义千问，也可以填自定义地址
- 模型先调用 `capability_load`，再使用文件读写、工作区 Shell，或读取 `SKILL.md`
- 工作区内的读取自动放行；写入要批准；Shell 每次都要批准
- SQLite 保存会话；审计日志用 SHA-256 串成哈希链
- MCP 只有类型和占位客户端，P0 不会真正拉起服务器

## 架构

```text
沙箱界面（没有 Node，也拿不到密钥）
        │  preload
        ▼
Electron 主进程
  策略、批准、审计、SQLite、密钥只留在内存
        │                         │
        ▼                         ▼
  agent 进程                   工具进程
  Pi agent loop                工作区内的文件和 Shell
  调用你配置的 baseUrl
```

Pi（`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`）只负责模型回合和工具循环。它不是权限边界。工具回调必须回到主进程，主进程同意之后，工具进程才会执行。

## 环境

- macOS 14 或更新版本（正式使用）
- Node.js 22.14 或更新版本
- pnpm 10（可以用 Corepack）

仓库里的单元测试可以在 Linux 上跑。桌面壳在非 macOS 上也能启动，用来检查界面，但 P0 不承诺 Windows 或 Linux 桌面支持。

## 在 macOS 上运行

```bash
git clone https://github.com/gmnoah/DeskForge.git
cd DeskForge
corepack pnpm install
corepack pnpm dev
```

第一次打开后：

1. 在右侧选择一个项目文件夹。不要选 `/`。
2. 选择 DeepSeek、Kimi、通义千问或自定义，确认 `baseUrl` 和模型名，然后保存。
3. 把 API key 放到环境变量里再启动，或者在界面里临时填写。临时密钥只活在这次进程的内存中，不会写入 SQLite。
4. 发送一条工作说明。模型如果要读文件，会先加载 `files` 能力。

开发机检查：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke
```

`smoke` 会拉起 Electron、等到界面和两个 worker 就绪后退出。没有图形界面时可以在前面加 `xvfb-run -a`。

密钥从主进程的环境变量读取，名字见 [.env.example](.env.example)：

| 预设 | 变量 |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Kimi | `MOONSHOT_API_KEY` |
| 通义千问 | `DASHSCOPE_API_KEY` |
| 自定义，或上面三个都没设 | `DESKFORGE_API_KEY` |

`DESKFORGE_BASE_URL` 和 `DESKFORGE_MODEL` 会在还没有保存过模型时，预填到界面里。真正生效的是你点保存之后的 `baseUrl`。四个预设都走 Chat Completions 兼容协议，不把供应商锁死在某一家。

## 安全边界

- 渲染进程开启了 `contextIsolation` 和 `sandbox`，没有 Node，也没有文件系统
- 主进程拒绝把 `/` 设为工作区；文件路径会做真实路径检查，指向工作区外的符号链接会被拒绝
- Shell 的工作目录必须落在工作区里，子进程环境变量里不带 API key。这不是操作系统级沙箱：命令本身仍可能尝试访问外部路径，所以每条命令都要你看过再批准
- 少数明显危险的命令（例如删除根目录、`mkfs`、关机）会直接拒绝
- 审计记录不保存文件正文和密钥。启动时会重算哈希链
- P0 的 API key 会在单次运行期间交给 agent 进程，因为 Pi 在那里发 HTTP。渲染进程拿不到它

## 仓库

```text
apps/desktop        Electron 主进程、沙箱界面、agent worker、tool worker
packages/core       策略、路径、审计、SQLite、工具执行
packages/agent      Pi agent loop，以及可替换的 AgentDriver
```

内置技能在 `apps/desktop/resources/skills/workspace-notes/SKILL.md`。工作区里还可以放 `.deskforge/skills/<name>/SKILL.md`。

## 路线图

P1：

- MCP stdio 真正接上，仍然走同一套批准
- 模型请求改由主进程代理，密钥不再进入 agent 进程
- 崩溃后恢复未完成的批准
- 签名的 macOS 安装包
- 更多低风险工具

P2，这次不做：

- 飞书、企业微信、钉钉
- 无头服务
- Windows

## 许可

[MIT](LICENSE)。归属说明在 [NOTICE](NOTICE)。
