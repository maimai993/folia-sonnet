---
name: testing-strategy
description: Use when the task involves choosing how to validate a change in this repository, deciding whether to inspect a running dev server, run unit tests, run Playwright UI screenshot tests, or avoid unnecessary builds.
---

# Testing Strategy

这个 skill 用于判断当前任务应该采用哪一种验证方式。

## Core Rule

如果当前用户终端已经在运行热加载开发服务器，例如 `vercel dev`、`vite`、`npm run dev`、`npm run dev:electron`，不要再额外运行构建来“测试”问题。

优先做这些事：

- 读取现有开发服务器报错
- 根据报错定位代码
- 只在确实需要额外验证时补充最小必要测试

## Validation Decision Tree

### 1. 前端页面样式、交互、回归截图

优先使用 Playwright UI 测试：

- 命令：`npm run test:ui`
- 更新基线：`npm run test:ui:update`

适用场景：

- 首页、播放器、面板、Navidrome、本地音乐等前端 UI 改动
- 需要截图对比
- 需要验证浏览器端 mock 数据表现

注意：

- 正式基线在 `test/ui/*.spec.ts-snapshots/`
- `test-results/` 是临时产物，不应提交

### 2. 纯逻辑、解析、状态管理、工具函数

优先使用 Vitest 单元测试：

- 命令：`npm run test:unit`
- 如需针对单文件或某类测试，优先用 Vitest 的路径过滤

适用场景：

- `src/utils/**`
- `src/stores/**`
- `src/hooks/**` 中不依赖真实浏览器渲染的逻辑
- 歌词解析、缓存逻辑、搜索状态、theme 状态等

### 3. Electron / 打包 / release 流程

不要默认通过完整打包来验证。

优先顺序：

- 先读 workflow、脚本、日志
- 先做静态检查和最小范围验证
- 只有任务明确要求，或问题只会在打包阶段暴露时，才运行对应构建

涉及文件通常包括：

- `.github/workflows/*.yml`
- `electron/main.cjs`
- `package.json`

### 4. 开发服务器已经在跑

如果已有 dev server 在跑：

- 不要额外运行 `npm run build`
- 不要为了“确认一下”再启动第二个 dev server
- 优先读取现有终端错误和浏览器/运行时反馈

### 5. 仅改文档、issue template、配置说明

通常不需要运行测试。

只在以下情况补充验证：

- 改动影响脚本名、命令名、路径
- 改动和 workflow、测试配置、运行方式直接相关

## Practical Guidance

- 小改动用最小验证，不要默认全量跑一遍。
- 如果用户只问原因分析，可以先分析，不强行跑测试。
- 如果测试依赖 mock，优先复用现有 Playwright/Vitest mock 入口，不要临时造第二套机制。
- 如果构建命令和运行中的热加载服务冲突，优先保留热加载上下文。

## Repository-Specific Commands

- `npm run test:unit`
- `npm run test:ui`
- `npm run test:ui:update`

## What To Avoid

- 在已有热加载服务运行时，再跑 build 验证前端问题
- 为了一个 UI 小改动去跑 Electron 全量打包
- 把 `test-results/` 之类的临时产物提交进仓库
