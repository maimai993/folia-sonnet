import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineProviderId } from '../../../src/types/onlineMusic';
import ConfirmDialog from '../../../src/components/shared/ConfirmDialog';
import { omni } from '../../../src/services/onlineMusic/omni';
import { useLibraryStore } from '../../../src/stores/useLibraryStore';
import { useSearchNavigationStore } from '../../../src/stores/useSearchNavigationStore';
import { useCollectionNavigationStore } from '../../../src/stores/useCollectionNavigationStore';
import { useThemeSettingsStore } from '../../../src/stores/useThemeSettingsStore';
import { recordAccountCall } from './fakeAuthProviders';

// dev/probes/accountBehavior/ProbeProviderSwitch.tsx
// App.tsx 里切换确认那一段的最小复刻（prepareOnlineProviderSwitch / handleConfirmProviderSwitch /
// handleCancelProviderSwitch / providerSwitchConfirmDialog + AppDialogs 的 ConfirmDialog）：
// - prepare 把 resolve 塞进 useLibraryStore.providerSwitchPending，已有待确认请求时先按 false 结算旧的；
// - 确认时先清空 pending，再做清理、resolve(true)；清理里播放器那部分（audio、队列、歌词、prefetch……）
//   探针没有，只记一笔 switch-cleanup（带目标 provider），store 层的两步（搜索运行态、集合导航）照做；
// - 取消时 resolve(false) 并清空 pending。
// 改 App 这一段时要同步改这里；A4 把它提成宿主端口后，这个文件随之换成新端口的装配。

/** 与 App 的 prepareOnlineProviderSwitch 相同：返回的 Promise 在用户答复确认框时结算。 */
export const prepareProbeProviderSwitch = (_currentProviderId: OnlineProviderId, nextProviderId: OnlineProviderId): Promise<boolean> => (
    new Promise<boolean>((resolve) => {
        useLibraryStore.getState().setProviderSwitchPending(prev => {
            prev?.resolve(false);
            return { nextProviderId, resolve };
        });
    })
);

/** 与 AppDialogs 里 providerSwitchConfirmDialog 的 ConfirmDialog 相同的 props。 */
const ProbeProviderSwitchDialog: React.FC = () => {
    const { t } = useTranslation();
    const pending = useLibraryStore(state => state.providerSwitchPending);
    const setPending = useLibraryStore(state => state.setProviderSwitchPending);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);

    const handleConfirm = useCallback(() => {
        if (!pending) return;
        const { nextProviderId, resolve } = pending;
        setPending(null);
        recordAccountCall({ op: 'switch-cleanup', providerId: nextProviderId });
        useSearchNavigationStore.getState().resetRuntime(nextProviderId);
        useCollectionNavigationStore.getState().clear();
        resolve(true);
    }, [pending, setPending]);

    const handleCancel = useCallback(() => {
        if (!pending) return;
        pending.resolve(false);
        setPending(null);
    }, [pending, setPending]);

    if (!pending) return null;
    return (
        <ConfirmDialog
            isOpen
            isDaylight={isDaylight}
            title={t('home.switchOnlineProvider')}
            description={t('home.confirmOnlineProviderSwitch', { provider: omni.getProviderLabel(pending.nextProviderId) })}
            onConfirm={handleConfirm}
            onClose={handleCancel}
        />
    );
};

export default ProbeProviderSwitchDialog;
