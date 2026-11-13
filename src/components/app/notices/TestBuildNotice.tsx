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
//
// 「此版本不再提示」按**版本号**记：装了一个新的测试包还会再弹一次。这个提醒的意义是
// 「你现在用的这个包是什么来路」，换了包就该重新说一遍；只按一个布尔关掉的话，之后每个
// 测试包都会静默，等于把这个提醒删了。

/** 记「这个版本已经确认过」的键。值是版本号，不是 true/false。 */
const DISMISSED_KEY = 'test_build_notice_dismissed_version';

const readDismissedVersion = (): string => {
    try {
        return localStorage.getItem(DISMISSED_KEY) ?? '';
    } catch {
        return '';
    }
};

const rememberDismissed = (version: string): void => {
    try {
        localStorage.setItem(DISMISSED_KEY, version);
    } catch {
        // 存不进去就下次再弹一遍，不算错误。
    }
};

export const TestBuildNotice: React.FC = () => {
    const { t } = useTranslation();
    const isTestBuild = !isOfficialBuildBranch(__GIT_BRANCH__);
    /*
     * 开头就判一次版本：这一版确认过就不再弹。**不是**「确认过就永远不弹」——
     * 换一个包，版本号变了，提醒照旧回来。
     */
    const [isOpen, setIsOpen] = useState(() => (
        isTestBuild && readDismissedVersion() !== __APP_VERSION__
    ));

    useEffect(() => {
        if (!isTestBuild) return;
        console.info(`[TestBuild] 这一版从 ${__GIT_BRANCH__} 分支构建，不是 main / release/*，启动时提醒用户这是测试版`);
    }, [isTestBuild]);

    const dismissForThisVersion = () => {
        rememberDismissed(__APP_VERSION__);
        setIsOpen(false);
    };

    if (!isOpen) return null;

    return (
        <Sheet
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            size="s"
            title={t('testBuild.title', 'Test build')}
            titleLead={<TriangleAlert size={16} className="text-[color:var(--st-warn,var(--st-t2))]" />}
            footer={(
                <>
                    <SheetButton onClick={() => setIsOpen(false)}>
                        {t('testBuild.ok', 'Got it')}
                    </SheetButton>
                    <SheetButton onClick={dismissForThisVersion}>
                        {t('testBuild.dontShowAgain', 'Do not show for this version')}
                    </SheetButton>
                </>
            )}
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
