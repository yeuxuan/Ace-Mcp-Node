# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Ace-Mcp-Node 是一个基于 MCP (Model Context Protocol) 协议的代码库索引和语义搜索服务器，Node.js/TypeScript 实现。AI 助手通过 `search_context` 工具对指定项目进行增量索引并执行语义搜索。

## 常用命令

```bash
# 开发模式（热重载）
npm run dev
npm run dev -- --web-port 8080

# 生产构建
npm run build          # tsc 编译 + 复制 Web 模板到 dist/

# 运行编译结果
npm start
npm start -- --web-port 8080   # 启动 Web 管理界面（http://localhost:8080）
npm start -- --base-url https://api.example.com --token YOUR_TOKEN
```

无独立测试命令，手动测试方式：启动服务后通过 Web 界面 (`--web-port`) 中的"工具调试"面板测试 `search_context`。

## 架构概述

```
src/
├── index.ts              # MCP 服务器入口：注册工具、解析 CLI 参数、连接 stdio 传输
├── config.ts             # 配置单例：读取 ~/.acemcp/settings.toml，支持运行时 reload()
├── logger.ts             # 日志单例：文件轮转 + WebSocket 广播，禁止使用 console.log
├── index/
│   └── manager.ts        # IndexManager 核心：增量索引、文件收集、批量上传、语义搜索
├── tools/
│   └── searchContext.ts  # search_context 工具：参数验证 → 路径规范化 → 调用 IndexManager
├── utils/
│   ├── pathUtils.ts      # 跨平台路径规范化（WSL UNC、/mnt/c、Windows、Unix 互转）
│   └── detailedLogger.ts # 日志格式化工具
└── web/
    ├── app.ts            # Express REST API + WebSocket 服务器（配置/状态/项目/工具调试）
    ├── logBroadcaster.ts # 日志广播器单例：实时推送日志到 WebSocket 客户端
    └── templates/
        └── index.html    # 单页 Web 管理界面（状态、配置、实时日志、工具调试）
```

### 增量索引流程

`searchContext` 调用时自动触发：
1. `collectFiles()` 递归收集项目文本文件（遵循 `.gitignore` + `excludePatterns`）
2. 大文件按 `MAX_LINES_PER_BLOB` 分割为 chunks（路径加 `#chunk1of3` 后缀）
3. SHA-256(path + content) 计算 blob hash，与 `~/.acemcp/data/projects.json` 中已有记录取差集
4. 仅将新 blob 批量上传到 `BASE_URL/batch-upload`（含指数退避重试）
5. 调用 `BASE_URL/agents/codebase-retrieval` 执行语义搜索
6. 更新 `projects.json` 记录项目的所有 blob hashes

### 用户数据

```
~/.acemcp/
├── settings.toml       # 主配置（BASE_URL、TOKEN、BATCH_SIZE 等）
├── data/
│   └── projects.json   # 项目 → blob hash 列表映射（增量索引的状态文件）
└── log/
    └── acemcp.log      # 日志（5MB 轮转，保留 10 个）
```

## 关键开发规范

### ESM 导入必须带 `.js` 扩展名
```typescript
// ✅ 正确
import { getConfig } from './config.js';
// ❌ 运行时报错
import { getConfig } from './config';
```

### 禁止使用 console.log
MCP 服务器通过 stdio 通信，`console.log` 会污染协议流。始终使用：
```typescript
logger.debug / logger.info / logger.warning / logger.error / logger.exception
```

### 路径处理
所有路径操作前必须调用 `normalizeProjectPath()`，存储统一使用正斜杠。支持 Windows、Unix、WSL `/mnt/c/` 和 UNC `\\wsl$\` 格式。

### 新增 MCP 工具的步骤
1. 在 `src/tools/` 创建工具文件，遵循 `searchContextTool` 的模式（参数验证 → 日志 → 业务逻辑 → catch 返回错误文本）
2. 在 `src/index.ts` 的 `ListToolsRequestSchema` handler 添加工具描述
3. 在 `CallToolRequestSchema` handler 添加分支调用

### Web API 新增路由
在 `src/web/app.ts` 的 `createApp()` 函数中添加，路由统一返回 `{ error: string }` 格式的错误响应，成功响应用 `res.json()`。

## TypeScript 配置要点

- `target/module`: ES2022，严格模式 (`strict: true`)
- `moduleResolution`: node（不是 bundler）
- 构建输出到 `dist/`，Web 模板需单独 `copy-templates` 脚本复制（已集成到 `build` 命令）
