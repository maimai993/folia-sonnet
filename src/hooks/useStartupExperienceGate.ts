import { useCallback, useEffect, useState } from 'react';
import { USER_GUIDE_AUTO_OPEN_VERSION } from '../components/modal/userGuideContent';
import { hasOnboardingLibrarySuiteChoice } from '../library/app/librarySuiteChoice';
import { requestPlaybackEntryViewPrompt, usePlaybackEntryViewStore } from '../stores/usePlaybackEntryViewStore';
import { useSettingsModalStore } from '../stores/useSettingsModalStore';
import { useDeviceProfileStore } from '../stores/useDeviceProfileStore';
import { isAndroidNativeRuntime } from '../services/nativeLocalMusic';

// src/hooks/useStartupExperienceGate.ts

const LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY = 'folia_last_seen_guide_version';
const FREE_SOFTWARE_NOTICE_SEEN_STORAGE_KEY = 'folia_free_software_notice_seen';
/** 登录按钮那一层：点了就记下，每个安装只有一次。 */
const SIGN_IN_SPOTLIGHT_DONE_STORAGE_KEY = 'folia_sign_in_spotlight_done';

export type StartupExperienceStep =
    | 'free-software-notice' | 'release-notes' | 'playback-entry-view' | 'ponder' | 'sign-in-spotlight' | null;

type StartupExperienceState = {
    /** 免费软件声明还没看过。按安装计，不看版本。 */
    needsFreeSoftwareNotice: boolean;
    isFreeSoftwareNoticeOpen: boolean;
    isCurrentRelease: boolean;
    /** Ponder onboarding was completed in some version (it is shown once per install). */
    hasSeenPonder: boolean;
    /**
     * Ponder onboarding was completed in this version. It is the last startup step and nothing else opens it,
     * so this means the whole sequence already ran for this release.
     */
    hasFinishedThisRelease: boolean;
    hasSeenReleaseNotes: boolean;
    isReleaseNotesOpen: boolean;
    hasChosenPlaybackEntryView: boolean;
    /**
     * The library-interface page is still owed (both suites exist and it has never been shown). Unlike everything
     * else here it is not gated by the release: everyone is asked once (2026-10-10), whatever version they are on.
     */
    needsLibrarySuitePrompt: boolean;
    /**
     * 设备类型（手机 / 平板）还没问过。只在安卓上成立 —— 桌面端窗口多宽自己说了算。
     * 与资料库界面那页一样按安装计、不看版本，但同样只问一次。
     */
    needsDeviceTypePrompt: boolean;
    isPlaybackEntryViewPromptOpen: boolean;
    isPonderOnboardingOpen: boolean;
    /**
     * 首启最后一步还欠着：还没有人登录、有能登录的平台、而且这一层没有弹过。
     * 排在序列的最后 —— 前面该确认的都确认完了，才轮到它。
     */
    needsSignInSpotlight: boolean;
    isSignInSpotlightOpen: boolean;
};

/** Chooses the next blocking surface while ensuring that two startup dialogs never overlap. */
export const resolveStartupExperienceStep = ({
    needsFreeSoftwareNotice,
    isFreeSoftwareNoticeOpen,
    isCurrentRelease,
    hasSeenPonder,
    hasFinishedThisRelease,
    hasSeenReleaseNotes,
    isReleaseNotesOpen,
    hasChosenPlaybackEntryView,
    needsLibrarySuitePrompt,
    needsDeviceTypePrompt,
    isPlaybackEntryViewPromptOpen,
    isPonderOnboardingOpen,
    needsSignInSpotlight,
    isSignInSpotlightOpen,
}: StartupExperienceState): StartupExperienceStep => {
    if (isFreeSoftwareNoticeOpen || isReleaseNotesOpen || isPlaybackEntryViewPromptOpen || isPonderOnboardingOpen || isSignInSpotlightOpen) {
        return null;
    }
    // 声明排在最前面，而且不受版本门控：它回答的是「这是什么」，不是「这次更新了什么」，
    // 每个安装只看一次。放在这里而不是外面单独渲染，是为了让它和其它启动弹窗共用同一个
    // 「同时只开一个」的约束。
    if (needsFreeSoftwareNotice) {
        return 'free-software-notice';
    }
    // The release sequence (notes, the playback choice, the Ponder gate) only runs on the release that auto-opens
    // it, and not again once finished. Release notes are per version; the playback choice and the Ponder gate are
    // once per install, so having finished Ponder must not suppress a later release's notes.
    const releaseDue = isCurrentRelease && !hasFinishedThisRelease;
    if (releaseDue && !hasSeenReleaseNotes) {
        return 'release-notes';
    }
    // The library-interface page is owed once to every install, outside the release gate.
    // 设备类型同理：它是后来才加的一页，已经回答过「播放后进入的视图」的人也该被问到，
    // 否则一个装了旧版本的人永远不会看到它。
    if ((releaseDue && !hasChosenPlaybackEntryView) || needsLibrarySuitePrompt || needsDeviceTypePrompt) {
        return 'playback-entry-view';
    }
    if (releaseDue && !hasSeenPonder) return 'ponder';
    /*
     * 最后一步：把登录按钮送到脸上。
     *
     * 它排在序列末尾之外还有一个理由：前面每一层都是「知道有这么回事」，这一层是「必须做
     * 一件事才能过去」，被它压住的是整个应用，所以它只能等前面都走完。
     */
    return needsSignInSpotlight ? 'sign-in-spotlight' : null;
};

const readLastSeenReleaseNotesVersion = (): string | null => (
    typeof window === 'undefined'
        ? null
        : localStorage.getItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY)
);

const readHasSeenFreeSoftwareNotice = (): boolean => (
    typeof window !== 'undefined' && localStorage.getItem(FREE_SOFTWARE_NOTICE_SEEN_STORAGE_KEY) === '1'
);

const readHasPressedSignInSpotlight = (): boolean => (
    typeof window !== 'undefined' && localStorage.getItem(SIGN_IN_SPOTLIGHT_DONE_STORAGE_KEY) === '1'
);

/**
 * Runs the first-launch sequence: release notes, the two-page choice prompt (library interface, then
 * playback destination), the Ponder shortcut gate, and at the end the sign-in button brought to the
 * face. The prompt is gated by the playback choice alone, so installs that answered the older
 * single-page prompt are not asked again.
 *
 * `signedIn` and `canSignIn` are what the last step needs to know: there is no pointing at the
 * sign-in button for someone who already signed in, and none where no platform can be signed in to.
 * Both are read from the account by the caller — this hook holds no account of its own.
 */
export const useStartupExperienceGate = (
    { signedIn = false, canSignIn = false }: { signedIn?: boolean; canSignIn?: boolean } = {},
) => {
    const lastSeenPonderVersion = useSettingsModalStore(state => state.lastSeenGuideVersion);
    const isPonderOnboardingOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);
    const setIsPonderOnboardingOpen = useSettingsModalStore(state => state.setIsUserGuideModalOpen);
    const hasChosenPlaybackEntryView = usePlaybackEntryViewStore(state => state.hasChosenPlaybackEntryView);
    const hasSeenLibrarySuitePrompt = usePlaybackEntryViewStore(state => state.hasSeenLibrarySuitePrompt);
    const needsLibrarySuitePrompt = hasOnboardingLibrarySuiteChoice() && !hasSeenLibrarySuitePrompt;
    const hasAnsweredDeviceType = useDeviceProfileStore(state => state.hasAnsweredDeviceType);
    const needsDeviceTypePrompt = isAndroidNativeRuntime() && !hasAnsweredDeviceType;
    const isPlaybackEntryViewPromptOpen = usePlaybackEntryViewStore(state => state.isPlaybackEntryViewPromptOpen);
    const [lastSeenReleaseNotesVersion, setLastSeenReleaseNotesVersion] = useState(readLastSeenReleaseNotesVersion);
    const [hasSeenFreeSoftwareNotice, setHasSeenFreeSoftwareNotice] = useState(readHasSeenFreeSoftwareNotice);
    const [isFreeSoftwareNoticeOpen, setIsFreeSoftwareNoticeOpen] = useState(false);
    const [isReleaseNotesOpen, setIsReleaseNotesOpen] = useState(false);
    const [hasPressedSignInSpotlight, setHasPressedSignInSpotlight] = useState(readHasPressedSignInSpotlight);
    const [isSignInSpotlightOpen, setIsSignInSpotlightOpen] = useState(false);
    const appVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;

    const nextStep = resolveStartupExperienceStep({
        needsFreeSoftwareNotice: !hasSeenFreeSoftwareNotice,
        isFreeSoftwareNoticeOpen,
        isCurrentRelease: Boolean(appVersion && USER_GUIDE_AUTO_OPEN_VERSION === appVersion),
        hasSeenPonder: lastSeenPonderVersion !== null,
        hasFinishedThisRelease: Boolean(appVersion && lastSeenPonderVersion === appVersion),
        hasSeenReleaseNotes: Boolean(appVersion && lastSeenReleaseNotesVersion === appVersion),
        isReleaseNotesOpen,
        hasChosenPlaybackEntryView,
        needsLibrarySuitePrompt,
        needsDeviceTypePrompt,
        isPlaybackEntryViewPromptOpen,
        isPonderOnboardingOpen,
        needsSignInSpotlight: !signedIn && canSignIn && !hasPressedSignInSpotlight,
        isSignInSpotlightOpen,
    });

    useEffect(() => {
        if (nextStep === 'free-software-notice') {
            setIsFreeSoftwareNoticeOpen(true);
        } else if (nextStep === 'release-notes') {
            setIsReleaseNotesOpen(true);
        } else if (nextStep === 'playback-entry-view') {
            requestPlaybackEntryViewPrompt({
                withLibrarySuite: hasOnboardingLibrarySuiteChoice(),
                // 设备类型这一页由这里决定要不要出现：store 之间不互相引用（storeContract 守着），
                // 所以「安卓」和「问没问过」这两件事在调用方合成。
                withDeviceType: needsDeviceTypePrompt,
            });
        } else if (nextStep === 'ponder') {
            setIsPonderOnboardingOpen(true);
        } else if (nextStep === 'sign-in-spotlight') {
            setIsSignInSpotlightOpen(true);
        }
    }, [nextStep, setIsPonderOnboardingOpen]);

    const closeReleaseNotes = useCallback(() => {
        if (appVersion) {
            localStorage.setItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY, appVersion);
            setLastSeenReleaseNotesVersion(appVersion);
        }
        setIsReleaseNotesOpen(false);
    }, [appVersion]);

    // 关掉就记下看过。它不是「同意才能用」，所以关闭路径（右上角 X、点遮罩）也走这里 ——
    // 不记的话每次冷启动都会再弹一次。
    const closeFreeSoftwareNotice = useCallback(() => {
        try {
            localStorage.setItem(FREE_SOFTWARE_NOTICE_SEEN_STORAGE_KEY, '1');
        } catch (error) {
            console.warn('[startup] Failed to persist the free-software notice flag:', error);
        }
        setHasSeenFreeSoftwareNotice(true);
        setIsFreeSoftwareNoticeOpen(false);
    }, []);

    /*
     * 点了那个按钮：这一层让位，并且从此不再出现。
     *
     * 它不按版本记：这是「认得那个按钮在哪」这件事，一个安装只有一次。写不进去（隐私模式、
     * 存储满了）也照样让位 —— 记不下最多是下次再指一次，把人关在这一层里才是真的错。
     */
    const pressSignInSpotlight = useCallback(() => {
        try {
            localStorage.setItem(SIGN_IN_SPOTLIGHT_DONE_STORAGE_KEY, '1');
        } catch (error) {
            console.warn('[startup] Failed to persist the sign-in spotlight flag:', error);
        }
        setHasPressedSignInSpotlight(true);
        setIsSignInSpotlightOpen(false);
    }, []);

    return {
        isFreeSoftwareNoticeOpen,
        closeFreeSoftwareNotice,
        isReleaseNotesOpen,
        closeReleaseNotes,
        isSignInSpotlightOpen,
        pressSignInSpotlight,
    };
};
