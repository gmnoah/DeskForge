# 新实现来源台账

创建：2026-10-06。实现：Codex，按用户授权。依据：用户提出的功能兼容目标和 docs/rebuild/PRODUCT.md、ARCHITECTURE.md、ACCEPTANCE.md。未复制旧业务文件，未按旧源码逐行改写。实现人员此前接触过现有移植源码，不能声明严格净室；下列“新编写”仍需独立来源评审。

| 文件 | 用途/来源 | 依赖 | 来源审查 |
|---|---|---|---|
| package.json | 新编写的独立包配置 | Node | 待审 |
| src/task.mjs | 新规格下的宿主任务控制器 | node:crypto | 待审 |
| src/workspace.mjs | 新规格下的工作区文件、预览、备份与回滚，新编写 | Node 标准库 | 待审；并发路径竞态待解决 |
| test/workspace.test.mjs | 根据文件边界和冲突不变量编写的独立测试 | Node 标准库 | 待审 |
| file-demo.mjs | 临时文件检索、审批与回滚演示，新编写 | 本目录模块、Node 标准库 | 待审 |
| test/task.test.mjs | 根据权限不变量编写的独立测试 | node:test、node:assert | 待审 |
| test/isolation.test.mjs | 静态导入边界检查 | Node 标准库 | 待审 |
| demo.mjs | 内存文档审批演示，示例文本新编写 | 本目录内核 | 待审 |
| README.md | 实施状态与运行说明，新编写 | 无 | 待审 |
| SOURCE_LEDGER.md | 来源与已接触旧源码记录 | 无 | 待审 |

未引入第三方图标、样式、提示词或业务包。最终软件许可与贡献者权利尚未决定；private 原型不得作为已完成来源审查的发行版。

隔离测试只检查当前静态导入和运行依赖；不检测代码表达来源，不替代资源检查、依赖许可检查和人工审查。
