# issue 工作流

规则原文在 AGENTS.md 的「Bug 与 issue」一节；本文是操作说明：什么时候先提 issue、PR 怎么写、门禁看什么、CI 红了的那条评论是什么意思。

## 先提 issue，再修 bug

要提：

- 能复现的 bug，尤其是别人报的、不是这次改动带出来的。
- 需要跨几次 PR 才能做完、或者要先讨论方案的问题。

不用提：

- 新功能、重构、文档：PR 里写清改了什么和为什么就够了（issue-link 门禁不要求关联）。
- 已经有同一条 issue：直接用它的编号，不要重复提。

提 issue 用 `gh issue create --repo maimai993/folia-sonnet`，或在网页 New issue（模板在 `.github/ISSUE_TEMPLATE/`）。标题写现象，正文写复现步骤、预期与实际、版本和平台。

## 流程

1. 修 bug 先提 issue，记下编号（例如 `#42`）；新功能、重构、文档可以跳过这一步。
2. 从 `dev` 切 `feat/*` 或 `fix/*` 分支，在分支上改。
3. 跑本地门禁 `npm run ci:local`（第一次跑之前先 `npm --prefix sync-server ci`）。
4. 开 PR 到 `dev`。修 bug 的 PR 正文写一行 `Closes #42`，合并后 GitHub 自动关掉这个 issue；其他 PR 有相关任务就写 `Refs #N`。
5. 盯 CI，红了当场修；修完推送会自动重跑。
6. 合并前至少一次 AI review（见 AGENTS.md「CI」）。

## PR 关联写法

门禁只对 `fix/*` 分支和带 `bug` 标签的 PR 生效；它只认 **PR 正文** 里的动词 + `#编号`，大小写不敏感，动词与 `#` 之间可以有半角或全角空格：

```text
Closes #12
Fixes #3
Resolves #99
Refs #7
```

- 可以写多行、一行多条。`Closes` / `Fixes` / `Resolves` 表示合并时关掉 issue；`Refs` 只表示相关，不关。
- 下面这些不算关联，门禁会红：
  - 只写编号：`#12`
  - 只提到 issue：`见 issue 里的讨论`、`这个现象和 #12 一样`
  - 动词和编号不在同一行：`Closes` 换行 `#12`
  - 只写在标题里（门禁只看正文）
- 本地自查不需要 `GITHUB_TOKEN`：

```bash
node ci/checkIssueLink.ts --text "Closes #12"
```

判定实现在 `ci/checkIssueLink.ts`，用例在 `test/unit/ci/issueLink.test.ts`。

## 门禁行为

`.github/workflows/issue-link.yml`：PR 的 opened / edited / synchronize / reopened / labeled / unlabeled 事件，目标是 `dev` 或 `main` 时跑 `node ci/checkIssueLink.ts`。它读 `GITHUB_EVENT_PATH` 里这个 PR 的分支、标签和正文：

- 分支不是 `fix/*`、也没有 `bug` 标签：通过，日志里说明本次不要求关联。
- 否则正文没有关联就红，日志里给出失败原因和下一步。
- 改 PR 正文会触发 `edited` 重新判定；补上或去掉 `bug` 标签会触发 `labeled` / `unlabeled`，都不用重新推代码。
- 权限只有 `contents: read`。
- 要不要把它设成必须通过的检查由分支保护决定（Settings → Branches），owner 在网页上配一次；目前没配。

## CI 红了的那条评论

`.github/workflows/ci-failure-notice.yml` 在 `CI` 这次运行失败后，在它对应的 PR 上留一条评论：

> CI 红了。若这是 bug：先 `gh issue create` 提 issue，再修复，PR 里写 `Closes #N`；动手前先读 AGENTS.md。

- 评论里带这次运行的链接。
- 同一个 PR 只有一条（固定标记 `<!-- ci-failure-notice -->`）：后续再红是更新那一条，不重复发。
- 找不到关联的 PR（`dev` / `main` 上的 push 运行、fork PR 关联为空）就直接跳过。
- 它只是提醒，不是门禁：真正拦合并的是 CI 和分支保护。

> 注意：GitHub 只会在**默认分支**（当前是 `main`）上运行 `workflow_run` 的 workflow。这个 workflow 合进 `dev` 之后、随发版进 `main` 之前，CI 红了不会有这条评论；issue-link 门禁不受影响，合进 `dev` 即生效。

## 相关文件

- `ci/checkIssueLink.ts`、`test/unit/ci/issueLink.test.ts`：关联判定与用例
- `.github/workflows/issue-link.yml`：门禁入口
- `.github/workflows/ci-failure-notice.yml`：失败评论入口
- `.github/pull_request_template.md`：PR 模板
- `AGENTS.md`「Bug 与 issue」：规则原文
