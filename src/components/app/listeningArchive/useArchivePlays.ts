import { useCallback, useEffect, useState } from 'react';
import { loadArchivePlays } from '../../../services/listeningArchive/repository';
import type { ArchivePlay } from '../../../services/listeningArchive/types';

// src/components/app/listeningArchive/useArchivePlays.ts
// 档案页读一次全部播放行：排行、时间轴、单曲轨迹、设置里的条数都从这一份里算。
//
// 读全量而不是按范围查：聚合口径全在 aggregate.ts 的纯函数里，范围切换只是换个入参，
// 不必每换一次就再问一次数据库；记录量按「一次播放一行」算，普通用户一年也就几千行。
// 关着的时候不读（overlay 没开就没有必要占用启动后的第一次 IDB 往返）。

export type ArchivePlaysState = {
    plays: ArchivePlay[];
    isLoading: boolean;
    /** 导入 / 清空之后重新读一次。 */
    reload: () => void;
};

export const useArchivePlays = (isEnabled: boolean): ArchivePlaysState => {
    const [plays, setPlays] = useState<ArchivePlay[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (!isEnabled) return undefined;
        let cancelled = false;
        setIsLoading(true);
        void loadArchivePlays()
            .then((loaded) => {
                if (!cancelled) setPlays(loaded);
            })
            .catch((error: unknown) => {
                console.warn('[ListeningArchive] 读取播放记录失败', error);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isEnabled, reloadToken]);

    const reload = useCallback(() => setReloadToken(token => token + 1), []);

    return { plays, isLoading, reload };
};

export default useArchivePlays;
