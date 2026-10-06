# DeskForge 手动验收清单（M1–M4，macOS）

这份清单供项目负责人在真实 Mac 上端到端验收 M1–M4。自动化测试（`pnpm typecheck`、`pnpm test`、`pnpm smoke`）已在 CI 和 Linux 上通过；下面这些需要真实 macOS 环境、钥匙串和真实模型 Key，只能手动验证。

- 预计耗时：完整走一遍约 60–90 分钟；只验 M4 约 20 分钟。
- 记录方式：每项通过就勾选 `[x]`；不通过时在项目下方写明现象、截图路径，以及「设置 → 隐私与记录 → 查看活动记录」里对应的条目。
- 时间以本机时区为准。

> DeskForge 是独立项目，不是 WorkBuddy，也不是腾讯的产品。

---

## 0. 准备

### 0.1 环境

- [ ] macOS 14 或更新版本（Apple Silicon 或 Intel 均可），已登录图形会话（钥匙串可用）。
- [ ] Node.js ≥ 22.14：`node -v`。
- [ ] pnpm 10.33：`corepack enable && pnpm -v`。
- [ ] Git、Xcode Command Line Tools（编译 `better-sqlite3` 需要）：`xcode-select --install`。
- [ ] 至少一个模型 Key：DeepSeek、Kimi（Moonshot）或通义（阿里云百炼 DashScope）。验收「向量检索」还需要一个 DashScope Key（同一个百炼 Key 即可）。

### 0.2 安装并启动

```bash
git clone https://github.com/gmnoah/DeskForge.git
cd DeskForge
pnpm install
pnpm dev
```

- [ ] `pnpm install` 无报错，`better-sqlite3` 和 `electron` 编译 / 下载成功。
- [ ] `pnpm dev` 打开 DeskForge 窗口，标题栏和侧栏显示 **DeskForge** 品牌，没有 WorkBuddy / 腾讯字样。
- [ ] （可选）另开终端执行 `pnpm typecheck && pnpm test`，全部通过。

### 0.3 准备测试工作区

在终端执行以下命令，创建一个包含中英文文档、被忽略文件、敏感文件和越界软链接的测试工作区（M2 搜索和 M4 知识库都会用到）：

```bash
mkdir -p ~/deskforge-test/ws/{docs,src,build} ~/deskforge-test/outside
cd ~/deskforge-test/ws
printf 'build/\n*.generated.md\n' > .gitignore
printf '# 第 40 周周报\n\n本周完成了支付服务的灰度发布。\n下周计划：回滚演练和容量评估。\n' > docs/周报.md
printf '# Deployment guide\n\nRun the canary rollout first.\nThen promote to production after smoke tests.\n' > docs/deploy.md
printf 'export function computeInvoiceTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0)\n}\n' > src/billing.ts
printf 'ignored build artifact\n' > build/out.md
printf 'ignored generated note\n' > notes.generated.md
printf 'API_KEY=should-never-be-indexed\n' > .env
printf 'outside workspace secret\n' > ../outside/secret.md
ln -s ../../outside/secret.md docs/link.md
```

- [ ] 另外放一个任意 `.docx`（比如用 Pages / Word 写两段中文并导出）到 `~/deskforge-test/ws/docs/方案.docx`，再放一个 PDF 到 `docs/`（用来确认 PDF 被跳过）。

---

## M1 可用性打底

### 1.1 引导与模型连接

- [ ] 首次启动进入引导页。选择服务商后，baseUrl 和默认模型自动填好：
  - DeepSeek：`https://api.deepseek.com/v1`，`deepseek-flash`
  - Kimi：`https://api.moonshot.cn/v1`，`kimi-k2.6`（国际站 Key 改用 `https://api.moonshot.ai/v1`）
  - 通义：`https://dashscope.aliyuncs.com/compatible-mode/v1`，`qwen-plus`
- [ ] 填写 Key，点「测试连接」：几秒内显示成功、耗时和模型。
- [ ] 故意填错 Key 再测：显示中文提示，例如「…拒绝了 API Key（认证失败）」，并给出处理建议；「技术信息」里的 Key 显示为 `[REDACTED]`。
- [ ] 故意把 baseUrl 改成 `https://api.deepseek.com/wrong`：提示「服务地址不正确」，并给出正确地址。
- [ ] 改回正确配置，点「安全保存并继续」。
- [ ] 「设置 → 模型」：再加一个其它服务商的配置并「测试连接」成功；切换默认模型；替换 Key 时留空表示保留原 Key。
- [ ] 打开「钥匙串访问」，能看到 Electron / DeskForge 的 Safe Storage 条目。用 `sqlite3` 打开应用数据目录（`~/Library/Application Support/DeskForge/deskforge.sqlite3`）下的数据库，`model_profiles.encrypted_key` 是二进制密文，搜不到明文 Key。

### 1.2 对话、报错与 Token 用量

- [ ] 新工作：「用三句话介绍一下你自己」。流式输出正常，结束后对话末尾和右侧「Token 用量」显示输入 / 输出 / 调用次数。
- [ ] 断开网络后再发一条：显示中文的「无法连接」类提示和建议；恢复网络后可以继续。
- [ ] 分别用 DeepSeek / Kimi / 通义各跑一个需要工具的任务（例如「列出工作区根目录有哪些文件」）：工具调用和多轮对话都正常，没有协议错误。

### 1.3 工作区授权

- [ ] 引导或「设置 → 工作区」中添加 `~/deskforge-test/ws`，并设为当前工作区。
- [ ] 让 Agent「读取 ../outside/secret.md」：被拒绝（越界），不会出现审批卡。
- [ ] 让 Agent「读取 docs/link.md」：被拒绝（软链接指向工作区外）。

---

## M2 工作区工具与审批体验

### 2.1 搜索

- [ ] 「找出工作区里所有 Markdown 文件」：Agent 使用 `file_find`，自动执行，不需要审批；结果不含 `build/out.md`、`notes.generated.md`。
- [ ] 「在工作区里搜索 canary」：Agent 使用 `file_search`，结果给出 `docs/deploy.md` 的行号；不包含 `.gitignore` 忽略的文件。
- [ ] 「用正则搜索 compute\w+Total」：返回 `src/billing.ts`。

### 2.2 审批卡与 diff

- [ ] 「在 docs/deploy.md 末尾加一行：Rollback with ./rollback.sh」：出现审批卡，带统一 diff（绿色新增行），可切换并排视图。
- [ ] 点「编辑参数」改一下内容再「修改后允许」：文件内容是修改后的版本。
- [ ] 「新建 docs/todo.md，写三条待办」：diff 全部显示为新增行。
- [ ] 「删除 docs/todo.md」：审批卡显示删除 diff；允许后文件进入工作区的 `.deskforge-trash`，可以在右侧「变更」页撤销。
- [ ] 「把 .env 里的 API_KEY 改成 test」：审批卡只显示增删行数，不显示 `.env` 的内容。
- [ ] 拒绝一次审批：Agent 收到拒绝，不会重试同一操作。

### 2.3 会话规则

- [ ] 写入审批时选择「本会话总是允许此类操作」并允许；同一会话里再写另一个文件时不再弹审批卡，活动记录里显示「会话规则自动批准」及命中的规则。
- [ ] 右侧「详细」页能看到这条规则，点「撤销」后，下一次写入重新需要审批。
- [ ] 让 Agent 运行 `pnpm -v` 或 `git status`，选「本会话总是允许」：之后同前缀的命令自动执行；`rm`、`curl`、`git push` 等命令永远不提供这个选项。
- [ ] 重启 DeskForge 后，会话规则全部失效。

### 2.4 审计日志

- [ ] 「设置 → 隐私与记录 → 查看活动记录」：能按工作、类别、结果、时间和关键字筛选。
- [ ] 哈希链状态显示「校验通过」；点「重新校验」仍通过。
- [ ] 分别导出 JSON、CSV、Markdown：保存对话框正常，文件中有 `prevHash` / `entryHash`，搜不到任何模型 Key。
- [ ] 「导出诊断包」：生成脱敏 JSON，搜不到 Key。

---

## M3 Skills 与 MCP

### 3.1 添加并测试 MCP Server（stdio）

使用官方公开的文件系统 MCP Server `@modelcontextprotocol/server-filesystem`（首次运行 `npx` 会下载，需要联网）：

- [ ] 「设置 → MCP 连接 → 添加 MCP Server」，传输选 **stdio**：
  - 名称：`本地文件`；工具命名空间：`files`
  - 命令：`npx`
  - 参数：`-y @modelcontextprotocol/server-filesystem .`
  - 工作目录：「当前工作区」
- [ ] 点「测试连接」：显示连接成功、连接方式 stdio、耗时，并列出 `read_file`、`list_directory` 等工具。
- [ ] 停用其中一个工具（例如 `write_file`），保存后它不再出现在可用工具里。
- [ ] 新工作：「用 files 的 MCP 工具列出工作区根目录」。`mcp_list_tools` 自动执行；`mcp_call_tool` **每次都弹审批卡**，并且没有「本会话总是允许」选项。
- [ ] 在环境变量里加一行 `MY_TOKEN=abc12345` 但不勾「加密保存」：保存失败，提示「请勾选加密保存」。勾选后保存成功，再编辑时值不回显。
- [ ] （可选）备选 Server：`npx -y @modelcontextprotocol/server-everything`，测试连接能列出 `echo` 等工具。
- [ ] 停用、再启用、删除 Server 都正常，活动记录里有对应条目。

### 3.2 导入 Skill（文件夹）

```bash
mkdir -p ~/deskforge-test/skills/hello-skill
cat > ~/deskforge-test/skills/hello-skill/SKILL.md <<'MD'
---
name: hello-skill
description: 用一句中文问候用户，并说明当前工作区名称。
---

当用户说「打个招呼」时，用一句中文问候，并说出当前工作区的名字。
MD
```

- [ ] 「资料库 → 技能 → 从文件夹导入」，选择 `~/deskforge-test/skills/hello-skill`：预览显示名称、文件清单和权限声明；确认后出现在技能列表中。
- [ ] 新工作：「打个招呼」：Agent 用 `skill_read` 读取 hello-skill 并按说明回答。
- [ ] 往该文件夹里放一个软链接（`ln -s /etc/hosts ~/deskforge-test/skills/hello-skill/hosts`）再导入：被拒绝，提示「Skill 包不能包含符号链接」。验证后删除这个软链接。

### 3.3 导入 Skill（Git）

- [ ] 「从 Git 导入」：地址 `https://github.com/gmnoah/DeskForge.git`，分支 `main`，子目录 `skills/examples/meeting-minutes`。预览显示 commit，并提示「将覆盖已安装的同名 Skill…，启用状态保持不变」。确认安装。
- [ ] 输入 `git@github.com:gmnoah/DeskForge.git` 或 `http://127.0.0.1/x.git`：被拒绝，提示只接受公开 HTTPS 地址。
- [ ] 对刚导入的 Skill 点「更新」：重新预览，安装后版本 / commit 更新。

### 3.4 示例 Skill

在测试工作区里分别试一下（只读写工作区，不联网）：

- [ ] `weekly-report`：「根据 docs 整理一份周报」，每条结论能对应到素材文件。
- [ ] `meeting-minutes`：给一段会议速记，输出决议、待办（负责人、截止时间）和未决问题。
- [ ] `document-key-points`：用 `方案.docx` 或任意文档，输出要点和原文出处。
- [ ] `spreadsheet-summary`：放一个 CSV，按维度汇总并核对总计；需要运行脚本时弹审批卡。
- [ ] `repo-overview`：在一个代码仓库工作区里生成技术栈和结构概览。

---

## M4 会话与本地知识

### 4.1 会话搜索

前提：已经有若干会话，其中至少一个标题或对话包含「周报」，另一个包含英文词（如 deploy）。

- [ ] 侧栏搜索框输入「周报」（两个字）：列出标题或内容含「周报」的会话，显示「标题」或「内容」标记和命中片段。
- [ ] 输入一个只出现在助手回复中的三字以上中文短语（如「回滚演练」）：能搜到对应会话，标记为「内容」。
- [ ] 输入英文 `DEPLOY`（大写）：能搜到含 deploy / Deployment 的会话（不区分大小写）。
- [ ] 输入 `"NEAR( *` 这类特殊字符：不报错，只是没有结果。
- [ ] 切换到另一个工作区：搜索结果只包含该工作区的会话。
- [ ] 清空搜索框：恢复「最近」列表。

### 4.2 重命名、导出、删除

- [ ] 打开一个会话，标题栏点「重命名会话」，改成「M4 验收会话」并保存：侧栏和标题同步更新；搜索「验收会话」能找到它；旧标题搜不到。
- [ ] 在这个会话里发一条带假密钥的消息：`测试脱敏：sk-test1234567890abcdef 和 password=hunter22`，等回复完成。
- [ ] 点「导出为 Markdown」：弹出保存对话框，默认文件名是「会话标题 + 日期.md」，默认位置是「文稿」。保存后提示导出路径。
- [ ] 打开导出的 `.md`：
  - 有元信息表（状态、工作区、模型、时间、Token 用量）、对话、「工具调用（N）」表格（工具、风险、状态、参数摘要、结果）、「审批记录」（结果和范围，如「已批准，范围：本会话规则」）；
  - `sk-test…`、`hunter22` 以及你真实的模型 Key 都显示为 `[REDACTED]`；
  - 没有系统提示词，也没有工具的完整输出。
- [ ] 在保存对话框点「取消」：不报错，也不生成文件。
- [ ] 活动记录里有「导出会话 … 为 Markdown」和「会话已重命名」两条记录。
- [ ] 对一个已结束的会话点「删除会话」：出现二次确认；确认后会话从侧栏和搜索结果中消失，活动记录仍保留。运行中的会话不显示删除按钮。

### 4.3 建立本地知识索引

- [ ] 「设置 → 本地知识库」：每个工作区一行，`ws` 显示「未建立」。
- [ ] 点「建立索引」：几秒内变为「已就绪」，显示文件数、片段数、正文大小和索引占用。应包含 `docs/周报.md`、`docs/deploy.md`、`src/billing.ts`、`docs/方案.docx`。
- [ ] 「已跳过」一行包含：忽略（`build/`、`notes.generated.md`、`.git` 等）、敏感文件 1（`.env`）、符号链接 1（`docs/link.md`）、不支持的类型（PDF 等）。
- [ ] 在终端确认工作区里**没有**新增任何索引文件：`ls -la ~/deskforge-test/ws`。索引在 `~/Library/Application Support/DeskForge/knowledge/<工作区ID>.sqlite3`。
- [ ] 设置页检索框（选 `ws`）：
  - 「回滚演练」→ 第一条是 `docs/周报.md:3-4`，片段含「回滚演练」，标记「关键词」；
  - 「周报」→ 命中 `docs/周报.md`；
  - `canary rollout` → 命中 `docs/deploy.md`；
  - `computeInvoiceTotal` → 命中 `src/billing.ts:1-…`；
  - `.docx` 中的一句话 → 命中 `docs/方案.docx`；
  - 「should-never-be-indexed」「outside workspace secret」「ignored build」→ **无结果**。

### 4.4 增量更新

- [ ] 修改 `src/billing.ts`（例如加一行注释「// 结算币种 CNY」），新建 `docs/new.md`（「灰度策略说明」），删除 `docs/deploy.md`。点「增量更新」：「上次：新增 1，更新 1，…，移除 1」。
- [ ] 检索「结算币种」命中 `src/billing.ts`；检索 `canary rollout` 不再命中已删除的文件；检索「灰度策略」命中 `docs/new.md`。
- [ ] 不改任何文件再点「增量更新」：全部计为「未变」，很快完成。
- [ ] 在 `.gitignore` 里加一行 `*.docx` 后增量更新：`docs/方案.docx` 被移除。
- [ ] 点「完全重建索引」（层叠图标）：重新索引所有文件。
- [ ] 点「清除索引」：出现确认框，说明只删除应用数据目录中的索引；确认后状态回到「未建立」，工作区文件不受影响。之后重新「建立索引」，供下一步使用。

### 4.5 Agent 使用 knowledge_search

- [ ] 新工作：「在本地知识库里查一下我们的发布计划和回滚安排，引用出处」。
  - Agent 调用「检索知识库」（`knowledge_search`），**不弹审批卡**；
  - 回答里引用 `docs/周报.md:3-4` 这样的「路径:行号」；
  - 右侧工作详情里能看到这次工具调用。
- [ ] 对一个还没建索引的工作区提同样的问题：工具返回「尚未建立本地知识索引」，Agent 提示你去设置里建立，或改用 `file_search`。
- [ ] 「只在 src/ 目录下的知识库里找 invoice」：Agent 使用 `pathPrefix: "src/"`，只返回 `src/` 下的结果。

### 4.6 向量检索（可选，需要 DashScope Key）

- [ ] 「设置 → 向量检索（可选）」：默认**关闭**，说明文字写明关闭时不会发送任何内容。
- [ ] 预设选「通义 DashScope · text-embedding-v4」：接口地址和模型自动填好，维度 1024。
- [ ] 填 API Key，打开「启用向量检索」，点「保存」：弹出确认框「允许把文档片段发送到 dashscope.aliyuncs.com？」，写明会发送文档片段（含相对路径）和检索词。点「确认并启用」后保存成功，Key 框显示「已保存」。
- [ ] 点「测试连接」：显示「连接成功：1024 维，… ms（测试只发送一句固定文本）」。
- [ ] 回到「本地知识库」点「增量更新」：状态里显示「N 个向量」。活动记录里有一条「向 dashscope.aliyuncs.com 发送 N 个文档片段生成向量」。
- [ ] 检索框输入一个语义相关但字面不同的词，例如「上线」或「release」：结果标题显示「混合排序（关键词 + 向量）」，至少一条标记为「语义」或「混合」，能找到 `docs/new.md` 或 `docs/周报.md`。活动记录里有「向 dashscope.aliyuncs.com 发送检索词生成向量」。
- [ ] 把 Key 改成错误值并保存，再检索：仍返回关键词结果，并提示「向量检索失败，已回退为关键词检索」，提示里没有 Key。
- [ ] 改回正确 Key。换成预设「text-embedding-v3」保存后增量更新：向量按新模型重新生成。
- [ ] 关闭「启用向量检索」并保存：检索结果恢复「关键词排序」；之后再检索或更新索引，活动记录里不再出现发送记录。
- [ ] 点「删除密钥」：Key 被删除，开关保持关闭。
- [ ] 数据库里 `app_secrets` 表只有密文，`settings` 表的 `knowledgeEmbeddings` 里没有 Key。

---

## 5. 收尾检查

- [ ] 退出 DeskForge 再启动：会话、索引状态、向量设置（关闭状态）都保留；会话规则已失效。
- [ ] 「设置 → 工作区」移除 `ws` 的授权：`~/Library/Application Support/DeskForge/knowledge/` 下对应的索引文件被删除。
- [ ] 全程没有看到 WorkBuddy / 腾讯字样；「关于」或 README 里保留了 OpenWorkbuddy 的 MIT 署名（见 `NOTICE`）。
- [ ] 清理：`rm -rf ~/deskforge-test`。

## 已知限制（M4 范围内，不算失败）

- PDF 暂不支持文本提取，会计入「不支持的类型」。
- 索引在主进程中顺序执行，没有进度条；单个工作区最多索引 5000 个文件，超出时显示截断原因。
- 会话搜索中，多个关键词需要出现在同一条标题或消息里。
- 向量检索用暴力余弦计算，适合个人工作区规模。
