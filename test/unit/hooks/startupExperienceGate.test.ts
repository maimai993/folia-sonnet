import { describe, expect, it } from 'vitest';
import { resolveStartupExperienceStep } from '../../../src/hooks/useStartupExperienceGate';

// test/unit/hooks/startupExperienceGate.test.ts

const readyState = {
    // 免费软件声明默认当作已经看过：下面每条断言讲的都是发版说明那一条序列。
    needsFreeSoftwareNotice: false,
    isFreeSoftwareNoticeOpen: false,
    isCurrentRelease: true,
    hasSeenPonder: false,
    hasFinishedThisRelease: false,
    hasSeenReleaseNotes: false,
    isReleaseNotesOpen: false,
    hasChosenPlaybackEntryView: false,
    needsLibrarySuitePrompt: false,
    needsDeviceTypePrompt: false,
    isPlaybackEntryViewPromptOpen: false,
    isPonderOnboardingOpen: false,
    needsSignInSpotlight: false,
    isSignInSpotlightOpen: false,
};

describe('startup experience gate', () => {
    it('orders release notes, playback entry choice, then Ponder onboarding', () => {
        expect(resolveStartupExperienceStep(readyState)).toBe('release-notes');

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
        })).toBe('playback-entry-view');

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
        })).toBe('ponder');
    });

    it('waits for each blocking surface to close before advancing', () => {
        expect(resolveStartupExperienceStep({
            ...readyState,
            isReleaseNotesOpen: true,
        })).toBeNull();

        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
            isPlaybackEntryViewPromptOpen: true,
        })).toBeNull();
    });

    it('does nothing once the sequence has finished for this release', () => {
        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenPonder: true,
            hasFinishedThisRelease: true,
        })).toBeNull();
    });

    it('shows Ponder only once per install, while each release still gets its notes', () => {
        const upgraded = { ...readyState, hasChosenPlaybackEntryView: true, hasSeenPonder: true };
        expect(resolveStartupExperienceStep(upgraded)).toBe('release-notes');
        expect(resolveStartupExperienceStep({ ...upgraded, hasSeenReleaseNotes: true })).toBeNull();
    });

    it('stays quiet on builds without release notes', () => {
        expect(resolveStartupExperienceStep({ ...readyState, isCurrentRelease: false })).toBeNull();
    });

    // 免费软件声明排在整个序列最前面，而且不看版本：每个安装只看一次。
    it('shows the free software notice first, once per install', () => {
        const owed = { ...readyState, needsFreeSoftwareNotice: true };
        // 压过发版说明。
        expect(resolveStartupExperienceStep(owed)).toBe('free-software-notice');
        // 不是自动弹发版说明的那一版也弹。
        expect(resolveStartupExperienceStep({ ...owed, isCurrentRelease: false })).toBe('free-software-notice');
        // 开着时后面的都等着，不叠弹窗。
        expect(resolveStartupExperienceStep({ ...owed, isFreeSoftwareNoticeOpen: true })).toBeNull();
        // 看过就回到原序列。
        expect(resolveStartupExperienceStep({ ...owed, needsFreeSoftwareNotice: false })).toBe('release-notes');
    });

    // 2026-10-10：「资料库界面」那一页每个安装都问一次，不看版本（发版说明的版本号每版都变，不能拿来门控它）。
    it('asks for the library interface once on every install, whatever the release', () => {
        const owed = { ...readyState, needsLibrarySuitePrompt: true };
        // 发版说明照旧排在前面。
        expect(resolveStartupExperienceStep(owed)).toBe('release-notes');
        expect(resolveStartupExperienceStep({ ...owed, hasSeenReleaseNotes: true })).toBe('playback-entry-view');
        // 答过旧版单页提问、这一版的流程也走完了的老安装：仍然问一次。
        const answered = { ...owed, hasSeenReleaseNotes: true, hasChosenPlaybackEntryView: true, hasSeenPonder: true, hasFinishedThisRelease: true };
        expect(resolveStartupExperienceStep(answered)).toBe('playback-entry-view');
        // 不是自动弹发版说明的那一版也问。
        expect(resolveStartupExperienceStep({ ...owed, isCurrentRelease: false, hasChosenPlaybackEntryView: true })).toBe('playback-entry-view');
        // 问过就不再问；开着时等它关。
        expect(resolveStartupExperienceStep({ ...answered, needsLibrarySuitePrompt: false })).toBeNull();
        expect(resolveStartupExperienceStep({ ...answered, isPlaybackEntryViewPromptOpen: true })).toBeNull();
    });

    // 首启最后一步：把登录按钮送到脸上。前面该确认的都确认完了才轮到它，而且不受版本门控。
    it('brings the sign-in button to the face only once everything else is confirmed', () => {
        const confirmed = {
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
            hasSeenPonder: true,
            hasFinishedThisRelease: true,
        };
        // 不欠这一层时，序列走完就什么都没有。
        expect(resolveStartupExperienceStep(confirmed)).toBeNull();

        const owed = { ...confirmed, needsSignInSpotlight: true };
        expect(resolveStartupExperienceStep(owed)).toBe('sign-in-spotlight');
        // 不是自动弹发版说明的那一版也指：它回答的是「那个按钮在哪」，不是「这次更新了什么」。
        expect(resolveStartupExperienceStep({ ...owed, isCurrentRelease: false })).toBe('sign-in-spotlight');
        // 每一层都压在它前面。
        expect(resolveStartupExperienceStep({ ...owed, needsFreeSoftwareNotice: true })).toBe('free-software-notice');
        expect(resolveStartupExperienceStep({ ...owed, hasSeenReleaseNotes: false, hasFinishedThisRelease: false })).toBe('release-notes');
        expect(resolveStartupExperienceStep({ ...owed, needsLibrarySuitePrompt: true })).toBe('playback-entry-view');
        // 它自己开着时不再弹第二层。
        expect(resolveStartupExperienceStep({ ...owed, isSignInSpotlightOpen: true })).toBeNull();
    });
});
