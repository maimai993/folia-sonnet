// src/utils/buildChannel.ts
// 这一份构建是从哪条分支出来的（纯数据，叶子层）。vite.config.ts 在 define 里把 __GIT_BRANCH__ 钉进包里，
// 正式渠道只有两个：main（合并后的发版）与 release/x.y.z（出包分支）。其余一律算测试版。
//
// 为什么值得单独一个文件：判据被启动提醒（components/app/notices/TestBuildNotice）与测试共用，而且
// 「什么算正式版」这一条规则不该散落在界面里 —— 改判据只改这里。

/** 合并后的发版分支。 */
export const OFFICIAL_BRANCH = 'main';
/** 出包分支：release/0.7.24 这样。 */
export const OFFICIAL_BRANCH_PREFIX = 'release/';

/** 这条分支出来的包算不算正式版。分不清（比如分离 HEAD 给的空串、'HEAD'）一律按测试版算，宁可多提醒一句。 */
export const isOfficialBuildBranch = (branch: string): boolean => (
    branch === OFFICIAL_BRANCH || branch.startsWith(OFFICIAL_BRANCH_PREFIX)
);
