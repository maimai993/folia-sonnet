## 改了什么

<!-- 一两句说清改了什么、为什么。涉及界面的，在这里附预览图。 -->

## 关联 issue

<!-- fix/* 分支和带 bug 标签的 PR 必须保留下面这行：Closes / Fixes / Resolves / Refs + #编号。
     其他 PR（feat / docs / refactor）有相关任务就写 Refs #N，没有可以整段删掉。
     用法与流程见 docs/issue-workflow.md。 -->
Closes #N

## 本地门禁已跑

- [ ] `npm run ci:local`（控件/体积/版本/密钥扫描 + typecheck + sync-server typecheck + 单测 + vite build + 产物密钥扫描；第一次跑之前先 `npm --prefix sync-server ci`）

## 界面

- [ ] 如涉及界面：已渲染预览图并请人工确认布局（见 docs/preview-rendering.md）

## 备注

<!-- 遗留项、已知风险、需要 review 重点关注的地方。 -->
