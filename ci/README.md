# ci

新 CI 的落地目录：检查逻辑都写在这里，`.github/workflows/` 只留薄入口调它。

## 现在有什么

- `checkVersionPolicy.ts`：版本约束检查，`npm run check:versions`。CI 的 `version-policy` job 和 `test/unit/versionPolicy.test.ts` 跑的是同一份实现。
  查的是：平台依赖钉死且与 `deploy/docker/<平台>-api/package.json` 同版本；`.nvmrc`、`engines.node` 与各 workflow 的 `node-version` 一致；版本号满足 `android/app/build.gradle` 的 versionCode 推导；锁文件版本和 `package.json` 同步。
- `contracts/extract.ts`：把三份隐式契约抽成 `docs/contracts/manifest/` 下的 manifest —— `electron/preload.cjs` 的 contextBridge 暴露面、`sync-server/src/app.ts` 挂载的路由、`src/services/onlineMusic/providerRegistry.ts` 注册的 omni provider。`node ci/contracts/extract.ts` 校验 manifest 与当前实现一致，`--update` 重写；`test/unit/contracts/contractsDrift.test.ts` 跑同一份实现，实现改了而 manifest 没跟上时 CI 红。
- `uiPolicy.ts`：两条重构门禁。`npm run check:ui` 禁止在 `src/components/ui/` 与设置页 kit 之外手写 `<button>/<input>/<select>/<textarea>`；`npm run check:size` 禁止文件超过 800 行。基线 `uiControlBaseline.json`、`fileSizeBaseline.json` 只许变小，收紧时跑 `node ci/uiPolicy.ts all --update`。
- `checkSecrets.ts`：密钥泄漏门禁。`node ci/checkSecrets.ts` 扫 `.env.example` 与 `src/`、`electron/`、`shared/`、`api/`：名字里带 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH 的 `VITE_` 变量（Vite 会把值内联进前端包），以及 `sk-`、`AIza`、`ghp_`、`github_pat_`、`xox[baprs]-`、`Bearer` 这类明文密钥形态；`node ci/checkSecrets.ts --dist dist` 在打包之后扫产物（CI 的 `build-web` 跑这条），查上面的形态和产物里出现的密钥环境变量值。假值走 `secretsAllowlist.json`，每条必须写理由。检查项清单与规则见 `docs/contracts/secrets-guard.md`。

## 为什么入口还在 .github/workflows

GitHub 只运行 `.github/workflows/*.yml`，子目录不读。所以那里只能放入口：

- `ci.yml`：调本目录的检查，加上 typecheck、单测、`vite build` 冒烟。
- `android-release.yml`：APK/AAB 出包，`v*` 标签或手动 `workflow_dispatch` 触发。

其余 workflow（`electron-release`、`canary-pre-release`、`nightly-pre-release`、`release-candidate`、`docker-*`、`triage-*`、`codemap-sync`、`linux-arm64-package-check`、`sync-server-docker-publish`）是沿用上游的旧流程，之后逐个替换或删除；换掉时直接删文件，不要往这里搬。

## 提 PR：不熟 GitHub 就照着抄

```text
git switch -c fix/登录超时 origin/dev                  # 1. 从 dev 切一个分支，别再往 main/dev 上写
# ...改代码...
git add -A && git commit -m "fix: 登录超时后不再卡住"    # 2. 提交
npm run pr -- "fix: 登录超时后不再卡住" --issue 42       # 3. 本地门禁 → 推分支 → 建 PR（一条命令）
# 4. 盯 CI：有 gh 用 gh pr checks <PR号> --watch，没有就开 PR 页面的 Checks 标签
```

`npm run pr` 会做这些事，做不了就当场说清楚原因：

- 拒绝在 `main` / `dev` 上直接提 PR；
- `fix/*` 分支要求 `--issue <编号>`：先 `gh issue create` 提 issue，正文会自动写一行 `Closes #编号`（新功能 / 文档不强制，有相关任务自己在正文补 `Refs #编号`）；
- 拒绝还有没提交的改动；
- 先跑 `npm run ci:local`（加 `--skip-ci` 可跳过，但 CI 照样拦你）；
- `git push -u origin` 当前分支（HTTPS 或 SSH 都行，用你 git 自己的凭据）；
- **fork 场景**：配了 `upstream` remote 且与 `origin` 不同时，PR 建到 upstream，head 写 `<fork 的 owner>:<分支>`；`--repo owner/repo` 可以手动指定目标仓库。没有 gh 时打印的 compare 链接同样指向目标仓库；
- 有可用的 `gh` 就 `gh pr create --repo <目标仓库> --base dev`（fork 时加 `--head owner:分支`）；没有就打印一个 **compare 链接**，浏览器打开点 Create pull request；
- 最后打印「盯 CI」和「要 review」的下一步。

**`gh` 是可选的**，不是硬依赖：
- 装了且 `gh auth login` 过：全自动，`--watch` 能直接盯 CI；
- 走 SSH 认证 / 没装 gh / 不想登录：`npm run pr` 照样 push 并打印浏览器链接，之后在 PR 页面的 **Checks** 标签盯 CI、在 **Files changed → Review changes → Comment** 写 review；
- 想装：`winget install GitHub.cli`（macOS `brew install gh`），再 `gh auth login`。

**Windows 上的已知失败**：`npm run ci:local` 里 `test/unit/mod-system/modSignature.test.ts` 有一条用例要在临时目录建符号链接，没开「开发者模式」或不是管理员时会被 EPERM 拒。不是你改出来的；其余通过就能开 PR，这一项以 Linux 的 CI 为准。

**合并前必须有 review**（至少一次 AI review，必须发在 GitHub 的 PR 上）：有 gh 用 `gh pr review <PR号> --comment --body-file review.md`，没有就在网页 **Files changed → Review changes → Comment** 里写。只在聊天里说「看过了」不算。

## 加一个检查

1. 本目录写脚本。Node 24 能直接跑 TypeScript（`node ci/xxx.ts`），不装依赖，所以能在没有 `npm ci` 的 job 里跑。
2. `package.json` 加一条 `npm run` script。
3. `ci.yml` 里加一个 step；需要 `node_modules` 的检查放进带 `npm ci` 缓存的 job。
4. 逻辑里能单独测的部分，在 `test/unit/` 补一条用例（参考 `versionPolicy.test.ts`）。
