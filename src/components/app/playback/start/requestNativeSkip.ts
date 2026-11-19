import { FoliaPlayback } from '../../../../hooks/useCapacitorPlaybackBridge';
import { cancelSessionResume } from '../../../../stores/usePendingResumeStore';

// 原生可能原地重播同一首；即使还没收到新曲身份，旧的续播请求也必须让位。
export async function requestNativeSkip(direction: 1 | -1): Promise<boolean> {
    cancelSessionResume();
    try {
        return (await FoliaPlayback.requestSkip({ direction })).skipped;
    } catch {
        // 桥不可用（老版本原生没有这个方法）：照常走 Web 流程。
        return false;
    }
}
