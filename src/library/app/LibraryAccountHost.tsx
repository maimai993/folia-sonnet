import React, { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { LibraryAccountController, LibraryLoginPhase } from '../core/contracts/account';
import { useLibraryAccountLogin, useLibraryAccountPendingSwitch, type LibraryLoginView } from '../core/bindings/useLibraryAccount';
import OnlineProviderLoginModal from '../../components/app/home/OnlineProviderLoginModal';
import { buildQrLoginDiagnosticsProps } from '../../components/app/home/buildQrLoginDiagnosticsProps';
import ConfirmDialog from '../../components/shared/ConfirmDialog';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import qqIcon from '../../assets/providers/qq.svg';
import wechatIcon from '../../assets/providers/wechat.svg';
import type { LibraryAccountLayer } from './libraryAccountLayer';

// src/library/app/LibraryAccountHost.tsx
// 在线账户的界面宿主（Library v2 · A4）：挂在首页外壳里（寿命与网格首页相同，换 suite 不卸载），按账户 controller
// 的快照渲染登录弹窗与切换确认框。本步仍是网格现有的两个展示组件（OnlineProviderLoginModal、通用 ConfirmDialog），
// 外观与 DOM 不变：登录弹窗 portal 进首页 surface 交上来的层（见 libraryAccountLayer），确认框 portal 到 body
// （原先在 AppDialogs 层，fixed z-200 盖住首页与切换器）。A5 起这里改成按 suite 解析 account surface。
// 宿主卸载（首页整个藏起）时关闭登录、取消待确认切换，与原先 Grid3D 卸载时停掉扫码会话等价。

// provider 只声明 iconKey 字符串，静态资源的映射留在 UI 层，services 层不碰 .svg。
const LOGIN_METHOD_ICONS: Record<string, string> = {
    qq: qqIcon,
    wechat: wechatIcon,
};

type LoginModalProps = React.ComponentProps<typeof OnlineProviderLoginModal>;

/** 登录弹窗只认扫码状态：还没开始要码的两步（解析方式、选方式）对它来说是 idle。 */
const toModalState = (phase: LibraryLoginPhase): LoginModalProps['state'] => (
    phase === 'resolving-methods' || phase === 'choosing-method' ? 'idle' : phase
);

/** 把已翻译的登录快照与 controller 动作装成登录弹窗的 props（与原 Grid3D 传的那一套同形）。 */
const buildLoginModalProps = (
    view: LibraryLoginView,
    account: LibraryAccountController,
    t: TFunction,
): LoginModalProps => {
    const { session } = view;
    return {
        title: view.title,
        note: view.note,
        qrCodeImg: session.qrImageUrl,
        statusText: view.status ?? '',
        state: toModalState(session.phase),
        retryLabel: view.retryLabel,
        closeLabel: view.closeLabel,
        loginMethods: view.methodStep
            ? {
                title: view.methodStep.title,
                hint: view.methodStep.hint,
                pendingText: view.methodStep.pending,
                currentText: view.methodStep.current,
                options: view.methodStep.options.map(option => ({
                    id: option.id,
                    label: option.label,
                    iconUrl: LOGIN_METHOD_ICONS[option.iconKey] || '',
                })),
                selectedId: session.selectedMethodId,
                onSelect: methodId => void account.selectLoginMethod(methodId),
            }
            : undefined,
        backendFailure: view.backendFailure
            ? {
                title: view.backendFailure.title,
                detail: session.backend.detail,
                restartLabel: view.backendFailure.restartLabel,
                restartingLabel: view.backendFailure.restartingLabel,
                restarting: session.backend.restarting,
                onRestart: () => void account.restartLoginBackend(),
            }
            : undefined,
        diagnostics: view.canShowDiagnostics && session.failure
            ? buildQrLoginDiagnosticsProps({
                t,
                providerId: session.providerId,
                failure: session.failure,
                buildReport: async () => {
                    const result = await account.buildLoginDiagnosticReport();
                    if (result.status !== 'ok') throw new Error('no login session to report');
                    return result.report;
                },
            })
            : undefined,
        onRetry: () => void account.retryLogin(),
        onClose: () => void account.closeLogin(),
    };
};

type LibraryAccountHostProps = {
    account: LibraryAccountController;
    layer: LibraryAccountLayer;
};

const LibraryAccountHost: React.FC<LibraryAccountHostProps> = ({ account, layer }) => {
    const { t } = useTranslation();
    const login = useLibraryAccountLogin(account);
    const pendingSwitch = useLibraryAccountPendingSwitch(account);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const layerElement = useSyncExternalStore(layer.subscribe, layer.getElement, layer.getElement);

    // 宿主卸载：停掉扫码会话（keyed 取消）、待确认切换按取消结算。controller 本身属于 App，不在这里 dispose。
    useEffect(() => () => {
        account.closeLogin();
        const pending = account.getSnapshot().pendingSwitch;
        if (pending) account.cancelSwitch(pending.id);
    }, [account]);

    const loginModal = (
        <AnimatePresence>
            {login?.visible && <OnlineProviderLoginModal {...buildLoginModalProps(login, account, t)} />}
        </AnimatePresence>
    );
    const canPortal = typeof document !== 'undefined';

    return (
        <>
            {layerElement ? createPortal(loginModal, layerElement) : loginModal}
            {pendingSwitch && canPortal && createPortal(
                <ConfirmDialog
                    isOpen
                    isDaylight={isDaylight}
                    title={pendingSwitch.title}
                    description={pendingSwitch.description}
                    // 不等确认的事务（清理、刷新）走完：controller 同步清掉待确认请求，框随之收起。
                    onConfirm={() => void account.confirmSwitch(pendingSwitch.request.id)}
                    onClose={() => void account.cancelSwitch(pendingSwitch.request.id)}
                />,
                document.body,
            )}
        </>
    );
};

export default LibraryAccountHost;
