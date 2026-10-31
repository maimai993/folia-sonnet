import React, { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetButton } from '../../shared/Sheet';
import { isOfficialBuildBranch } from '../../../utils/buildChannel';

// src/components/app/notices/TestBuildNotice.tsx
// 测试版的启动提醒：这一份构建不是从 main 或 release/* 出来的，就在启动时弹一次，说清它是哪条分支的包。
//
// 为什么要有：发版只该从 main（合并后）/ release/x.y.z 出。从 feat/*、fix/* 直接打的包一样能装、一样能听歌，
// 拿到手的人分不出它和正式版 —— 出了问题的第一反应是「正式版坏了」。把分支名摆在脸上，省掉这一轮猜测。
//
// 判据用的是构建时钉进包里的 __GIT_BRANCH__（vite.config.ts 在 define 里写），不是运行时的 git：
// 装到手机上的包没有仓库，也不该为了弹这个窗去问网络。什么算正式版见 utils/buildChannel。

export const TestBuildNotice: React.FC = () => {
    const { t } = useTranslation();
    // 每次启动都弹：这版是什么来路，不该只提醒一次就被记成「已读」。
    const [isOpen, setIsOpen] = useState(() => !isOfficialBuildBranch(__GIT_BRANCH__));

    useEffect(() => {
        if (isOfficialBuildBranch(__GIT_BRANCH__)) return;
        console.info(`[TestBuild] 这一版从 ${__GIT_BRANCH__} 分支构建，不是 main / release/*，启动时提醒用户这是测试版`);
    }, []);

    if (!isOpen) return null;

    return (
        <Sheet
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            size="s"
            title={t('testBuild.title', 'Test build')}
            titleLead={<TriangleAlert size={16} className="text-[color:var(--st-warn,var(--st-t2))]" />}
            footer={<SheetButton onClick={() => setIsOpen(false)}>{t('testBuild.ok', 'Got it')}</SheetButton>}
        >
            <p className="text-[13px] leading-6 text-[color:var(--st-t2)]">
                {t('testBuild.body', {
                    branch: __GIT_BRANCH__ || t('testBuild.unknownBranch', 'unknown'),
                    defaultValue: 'This build comes from the {{branch}} branch, not from main or a release/ branch. Features may be missing and data may be wrong; do not use it as your everyday build.',
                })}
            </p>
        </Sheet>
    );
};

export default TestBuildNotice;
