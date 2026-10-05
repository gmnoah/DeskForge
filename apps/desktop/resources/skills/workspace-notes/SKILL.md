---
name: workspace-notes
description: 在当前工作区里整理 Markdown 笔记时使用。
---

# 工作区笔记

只读写工作区内部的 Markdown。先用 `capability_load` 加载 `files`。写入前会由 DeskForge 向用户请求批准。

不要把笔记写到工作区外面，也不要建议把工作区设成文件系统根目录 `/`。
