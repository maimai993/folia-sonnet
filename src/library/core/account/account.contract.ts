import type { Theme } from '../../../types';
import type { LoginFailure } from '../../../types/loginFailure';
import type {
    LoginDiagnosticLine,
    LoginLocalService,
    LoginMethod,
    LoginPasswordField,
    LoginSelfCheckResult,
    LoginState,
    LoginTexts,
    OnlineProviderId,
    PasswordLoginCredentials,
    ProviderAccountSummary,
    ProviderCapabilities,
    ProviderSetupView,
    ProviderUser,
} from '../../../types/onlineMusic';
import type { LibraryHomeMessage } from '../home/homeModel.contract';

// src/library/core/account/account.contract.ts
// 在线账户的契约（Library v2 · A1）：登录会话（扫码或在浏览器里确认）、账户选择、切换确认与登出由 core 的账户
// controller 持有。登录窗口（src/components/login，宿主挂一个，所有 suite 共用）画登录会话；suite 画自己的平台列表
// 与切换确认，经同一个 controller 驱动流程。这里只有类型：快照、各动作的判别式结果、controller 接口、controller
// 依赖的端口，以及 account surface 的 props 与动作 id。
// 账户真源仍是 useOnlineProviderAccountStore，controller 只经端口读写它，不建第二份账户状态。
// 纯规则在 core/account/accountRules（选平台、可登出、可重来、等待再试到什么时刻等派生）。

// ─── 快照 ───────────────────────────────────────────────────────────────

/**
 * 登录会话的阶段：
 * - resolving-methods：正在等 provider 说它有哪几种登录方式（`resolveLoginMethods`）；
 * - choosing-method：provider 声明了多种方式、还没选，不向平台要码（QQ 两步式的第一步）；
 * - password：密码登录（飞牛这类自建服务没有二维码），等用户填表；提交中也是它，由表单自己显示转圈；
 * - ready：在浏览器里确认的登录，等用的人按「打开浏览器」（沿着平台那一列走不会开出浏览器）；
 * - loading：正在要二维码或开始浏览器登录；waiting / scanned / confirmed / expired / error：平台报的状态（`LoginState`）；
 * - checking：账号读到了，正在做平台声明的登录后检查（`checkAfterLogin`），之后要么完成，要么停在配置清单上。
 */
export type LibraryLoginPhase =
    | 'resolving-methods'
    | 'choosing-method'
    | 'password'
    | 'ready'
    | 'loading'
    | LoginState['state']
    | 'checking';

/** 密码登录提交失败的原因。界面按它给一句能照做的提示，而不是统一的「登录失败」。 */
export type LibraryPasswordLoginError =
    /** 账号或密码不对：让用户重填，不要当成登录态过期。 */
    | 'invalid-credentials'
    /** 连不上服务器（地址写错、NAS 没开、网络不通）。 */
    | 'network'
    /** 服务器回了，但不是能登录的状态（没这项能力、地址不对）。 */
    | 'unavailable'
    /**
     * 这台机器前面那一层（飞牛走 FN Connect 网关时）要求先在网页里登录一次：
     * 账号密码本身没错，是这层不认只带账号密码的请求。
     */
    | 'web-login-required'
    /** 登录成功了，可账户刷新没跟上。 */
    | 'refresh'
    | 'unknown';

/**
 * 登录要靠的本地服务（桌面端内嵌的后端，provider 经 `auth.localService` 声明）此刻的样子。
 * 没有这样的服务时 available 为 false，其余都是空值。
 */
export type LibraryLoginLocalServiceState = {
    available: boolean;
    /** 服务没能起来。 */
    failed: boolean;
    /** 服务自己的错误原话（可能为空）。 */
    error: string | null;
    restarting: boolean;
};

/**
 * 登录后端（provider 自己的后端，目前只有网易的本地后端会报）此刻的健康，
 * 规则见 core/account/accountRules 的 resolveLoginBackendState。
 * failed 时码必然拿不到：界面以故障原因与重启入口替换二维码，重试与诊断都不显示。
 */
export type LibraryLoginBackendState = {
    failed: boolean;
    /** 后端报的错误详情（可能为空）。 */
    detail: string | null;
    restarting: boolean;
    /** 故障且没有在重启中。 */
    canRestart: boolean;
};

/** 登录界面的文案（i18n key，UI 自己翻译）。status 为 null 表示此刻不显示状态行。 */
export type LibraryLoginCopy = {
    title: LibraryHomeMessage;
    note: LibraryHomeMessage;
    status: LibraryHomeMessage | null;
};

// ─── 登录失败后的自检（规则在 core/account/loginSelfCheckRules） ─────────

export type LoginSelfCheckVerdictKind =
    /** 桌面版：内嵌后端没在运行或没有回应。 */
    | 'backend-down'
    /** 网页版：配置的远端 API 连不上。 */
    | 'remote-unreachable'
    /** QQ：系统钥匙串不可用，登录态无法加密保存，扫码确认后必然失败。 */
    | 'credential-store'
    | 'dns-failed'
    /** TLS 握手阶段被重置：常见于代理、加速器、防火墙或运营商的干扰。 */
    | 'tls-reset'
    /** 某个域名所有地址都连不上（超时、拒绝、路由不可达等）。 */
    | 'upstream-unreachable'
    /** IPv4 能连上，IPv6 不行：系统可能优先走了坏掉的 IPv6（含 Teredo）。 */
    | 'ipv6-failed'
    /** 连接能建立，但 HTTPS 请求本身失败。 */
    | 'https-failed'
    | 'clock-skew'
    | 'network-ok';

export type LoginSelfCheckProxyKind = 'fake-ip' | 'system' | 'env';

export type LoginSelfCheckVerdict = {
    kind: LoginSelfCheckVerdictKind;
    /** 补充说明：出问题的域名与错误码、后端的错误原文、时钟偏差分钟数等；没有时为 null。 */
    detail: string | null;
    /** 有代理参与时附加提示；没有为 null。 */
    proxy: LoginSelfCheckProxyKind | null;
};

export type LoginSelfCheckItemId = 'backend' | 'credential-store' | 'dns' | 'ipv4' | 'ipv6' | 'https' | 'proxy' | 'clock';

export type LoginSelfCheckItem = {
    id: LoginSelfCheckItemId;
    state: 'ok' | 'fail' | 'warn' | 'skip';
    /** 失败或提示时的简短说明（错误码、域名）；正常时为 null。 */
    detail: string | null;
};

/**
 * 登录失败后的主动自检（provider 有自检能力时由会话自动跑一次）：
 * running 时界面显示「正在检查」；done 带结构化结果与结论；failed 是自检本身出错（原文进报告）。
 */
export type LibraryLoginSelfCheck =
    | { status: 'running' }
    | { status: 'done'; result: LoginSelfCheckResult; verdict: LoginSelfCheckVerdict }
    | { status: 'failed'; message: string };

/** 同一时间最多一个登录会话；换 suite 不中断（宿主持有 controller）。 */
export type LibraryLoginSessionSnapshot = {
    /** 会话代次：每次开始（含重来、换登录方式）都会换新，晚到的结果按它作废。 */
    id: number;
    providerId: OnlineProviderId;
    phase: LibraryLoginPhase;
    /** provider 声明的登录方式；空数组 = 单步流程。 */
    methods: readonly LoginMethod[];
    /** 多方式时已选的那个；重来保留它（否则用户会被踢回第一步）。 */
    selectedMethodId: string | null;
    /** 在浏览器里确认的登录（没有二维码，provider 在系统浏览器里打开登录的页面）。 */
    inBrowser: boolean;
    /** 二维码图片地址；还没拿到、或者是在浏览器里确认的登录时为空串。 */
    codeImage: string;
    /** 这一次登录的页面能不能由窗口再打开一次（provider 自己打开、关掉即结束的不能）。 */
    canReopenLoginPage: boolean;
    /**
     * 这一次为什么没有成功：是哪一种情况、它的事实、发生的时刻（services/onlineMusic/login/loginFailureCase）。
     * 没有出事、重新开始之后、确认之后是 null。「浏览器没有打开」时登录还在等（phase 仍是 waiting），只有它有值。
     */
    failure: LoginFailure | null;
    /** 失败后的自检；没有失败、没扫码就过期或 provider 没有自检能力时为 null。 */
    selfCheck: LibraryLoginSelfCheck | null;
    /**
     * 密码登录的表单（飞牛这类自建服务）。只有 provider 声明了 `passwordLogin` 才非空，
     * 界面据此画用户名 / 密码（可能还有服务器地址）而不是二维码。
     */
    passwordForm: {
        /** 表单里还要填服务器地址：自建服务每家地址不同，写不进构建期配置。 */
        needsServerUrl: boolean;
        /**
         * 这一栏叫什么（标签与占位符的 i18n key）：多方式登录时由选中的那一种给，
         * 例如「填 FN ID」与「填整条地址」是同一张表单上的两种问法；没有时用共用的那两句。
         */
        field: LoginPasswordField | null;
        /** 上次填过的服务器地址（登出不清地址，重登时少填一项）。 */
        serverUrl: string;
        /** 上一次提交失败的原因；还没提交过或上次成功了为 null。 */
        error: LibraryPasswordLoginError | null;
    } | null;
    backend: LibraryLoginBackendState;
    copy: LibraryLoginCopy;
    localService: LibraryLoginLocalServiceState;
    /** 这个平台自己的登录标题和说明（i18n key）；没有声明时为 null。 */
    texts: LoginTexts | null;
    /** 读到账号之后平台还要多查一步（步骤标记多一格）。 */
    checksAfterLogin: boolean;
};

/**
 * 开着的配置清单（同一时间最多一份）。sign-in：登录之后的检查给的，做完（finishSetup）才报这一次登录的完成；
 * account：从账号那一幅打开的，做完就收起，回到账号那一幅。
 */
export type LibraryProviderSetupSnapshot = {
    providerId: OnlineProviderId;
    view: ProviderSetupView;
    /** 正在做一个操作：清单上的按钮都不可按。 */
    busy: boolean;
    origin: 'sign-in' | 'account';
};

/**
 * 待用户确认的平台切换。切换不再拿走播放器里的东西（队列与正在放的歌留着），所以眼下 controller 不再生成它，
 * 快照里恒为 null；类型与 account surface 留给以后需要先问一句的切换。
 * - switch：用户选了一个能直接切过去的平台；
 * - activate-after-login：在非当前平台登录成功后，切过去之前问一句（拒绝时登录本身仍是成功的）。
 */
export type LibraryProviderSwitchReason = 'switch' | 'activate-after-login';

export type LibraryProviderSwitchRequest = {
    /** 请求 id：确认 / 取消按它结算，过期的 id 返回 stale。 */
    id: number;
    from: OnlineProviderId;
    to: OnlineProviderId;
    reason: LibraryProviderSwitchReason;
};

/** 登出进度：同一时间最多一个登出在途（含问用的人的那一会儿）。idle 时 providerId 为 null。 */
export type LibraryAccountLogoutState = {
    providerId: OnlineProviderId | null;
    status: 'idle' | 'pending';
};

/** 同步账户数据（重新读账号、歌单与红心）的进度：同一时间最多一个平台在同步。idle 时 providerId 为 null。 */
export type LibraryAccountSyncState = {
    providerId: OnlineProviderId | null;
    status: 'idle' | 'pending';
};

/** 登录确认之后的结局。 */
export type LibraryLoginOutcome = 'completed' | 'refresh-failed' | 'activation-declined';

/**
 * 最近一次登录确认的结局。确认后登录会话就关闭了（refresh-failed 除外：会话回到 error 让用户看到失败），
 * 登录窗口据它放登录成功的动画（sessionId 是那一次会话的代次）。
 */
export type LibraryLoginCompletion = {
    sessionId: number;
    providerId: OnlineProviderId;
    outcome: LibraryLoginOutcome;
};

export type LibraryAccountSnapshot = {
    /** provider 注册表 × 账户 store（omni.getProviderSummaries），mod 源增删时会变。 */
    providers: ProviderAccountSummary[];
    /** 已回落过的当前平台：存的平台不在列表里时是默认平台（core/account/accountRules 的 resolveActiveProviderId）。 */
    activeProviderId: OnlineProviderId;
    login: LibraryLoginSessionSnapshot | null;
    pendingSwitch: LibraryProviderSwitchRequest | null;
    logout: LibraryAccountLogoutState;
    sync: LibraryAccountSyncState;
    lastLoginCompletion: LibraryLoginCompletion | null;
    setup: LibraryProviderSetupSnapshot | null;
};

// ─── 动作结果（判别式，文案由 UI 自己翻译） ─────────────────────────────

/**
 * 某个平台此刻不能选的原因：
 * - not-configured：provider 声明未配置（`availability.configured === false`），界面上那一项本就是禁用的；
 * - unknown-provider：不在当前 provider 列表里（例如 mod 源刚被关掉）。
 */
export type LibraryProviderUnavailableReason = 'not-configured' | 'unknown-provider';

/** requestSwitch 的结局。切换不再问用的人，declined 只剩 controller 已销毁（disposed）。 */
export type LibrarySwitchResult =
    /** changed=false：本来就是当前平台，什么都没做。 */
    | { status: 'switched'; providerId: OnlineProviderId; changed: boolean }
    | { status: 'declined'; providerId: OnlineProviderId; reason: 'cancelled' | 'superseded' | 'disposed' }
    | { status: 'unavailable'; providerId: OnlineProviderId; reason: LibraryProviderUnavailableReason };

export type LibrarySwitchConfirmResult =
    | { status: 'confirmed'; requestId: number; providerId: OnlineProviderId }
    | { status: 'stale'; requestId: number };

export type LibrarySwitchCancelResult =
    | { status: 'cancelled'; requestId: number }
    | { status: 'stale'; requestId: number };

/**
 * startLogin 的结局。started 只表示会话已经建立：step=choosing-method 停在选方式，step=ready 等用的人打开浏览器，
 * step=started 已开始要码或开始浏览器登录；之后的进度（含开始失败）都在快照里。superseded：登录方式还没解析完
 * 就有更新的 startLogin（或关掉了）。
 */
export type LibraryStartLoginResult =
    | { status: 'started'; providerId: OnlineProviderId; sessionId: number; step: 'choosing-method' | 'qr' | 'password' | 'ready' | 'started' }
    | { status: 'superseded'; providerId: OnlineProviderId }
    | { status: 'unavailable'; providerId: OnlineProviderId; reason: LibraryProviderUnavailableReason };

/**
 * 提交一次密码登录的结局。failed 时登录快照留在界面上（`passwordForm.error` 已写好），
 * 用户改完再提交即可，不必重开一次登录。
 */
export type LibraryPasswordLoginResult =
    | { status: 'ok'; providerId: OnlineProviderId; sessionId: number }
    | { status: 'failed'; providerId: OnlineProviderId; sessionId: number; reason: LibraryPasswordLoginError }
    /** 此刻没有在进行的密码登录（界面不会走到这里）。 */
    | { status: 'no-session' }
    /** 提交期间关了窗、换了登录或 controller 已销毁：这一轮作废。 */
    | { status: 'superseded'; providerId: OnlineProviderId };

/**
 * selectProvider 走了哪一支（core/account/accountRules 的 resolveProviderSelection）。login 不开始登录：
 * 登录只由登录窗口开始，调用的人打开它（loginWindowStore 的 openLoginWindow）。
 */
export type LibrarySelectProviderResult =
    | { action: 'unavailable'; providerId: OnlineProviderId; reason: LibraryProviderUnavailableReason }
    | { action: 'switch'; result: LibrarySwitchResult }
    | { action: 'login'; providerId: OnlineProviderId };

/**
 * 在当前登录里开始或重来（选登录方式、重来、打开浏览器、本地服务重启后续上）被拒的原因：
 * - unknown-method：方式 id 不在会话的 methods 里；
 * - method-required：多方式但还没选；
 * - cooling-down：平台要求等一会儿再来（失败的 retryAfterMs），还没到那个时刻；
 * - not-retryable：此刻不能重来（还在解析方式、正在登录途中）。
 */
export type LibraryLoginRejectReason = 'unknown-method' | 'method-required' | 'cooling-down' | 'not-retryable';

export type LibraryLoginRequestResult =
    | { status: 'requested'; sessionId: number }
    | { status: 'no-session' }
    | { status: 'rejected'; reason: LibraryLoginRejectReason };

export type LibraryLoginCloseResult =
    | { status: 'closed'; sessionId: number }
    | { status: 'no-session' };

/** 再打开一次登录的页面（在浏览器里确认的登录）。 */
export type LibraryLoginPageResult =
    | { status: 'opened' }
    | { status: 'failed' }
    | { status: 'no-session' }
    | { status: 'rejected'; reason: 'not-reopenable' };

/**
 * 重启登录要靠的本地服务：起来了就把登录重新开始（resumed 带会话代次；这会儿登录自己走下去了就不再开始一次，
 * 代次不变）；没起来是 still-down。
 */
export type LibraryLocalServiceRestartResult =
    | { status: 'resumed'; sessionId: number }
    | { status: 'still-down' }
    | { status: 'no-session' }
    | { status: 'rejected'; reason: 'not-restartable' };

/** 打开配置清单：平台此刻没有要配置的是 none；平台不在列表里、或者没有清单是 unavailable。 */
export type LibrarySetupOpenResult =
    | { status: 'opened'; providerId: OnlineProviderId }
    | { status: 'none'; providerId: OnlineProviderId }
    | { status: 'unavailable'; providerId: OnlineProviderId };

/** 做清单上的一个操作：没有开着的清单是 no-setup；另一个操作还没做完是 busy；平台抛了错是 failed（清单不变）。 */
export type LibrarySetupActionResult =
    | { status: 'done' }
    | { status: 'no-setup' }
    | { status: 'busy' }
    | { status: 'failed' };

/** 诊断报告（services/onlineMusic/login/loginDiagnosticReport 的格式）；从没开始过登录时 no-session。 */
export type LibraryLoginDiagnosticResult =
    | { status: 'ok'; report: string }
    | { status: 'no-session' };

/** 登出被拒的原因（core/account/accountRules 的 resolveLogoutEligibility）：只有已登录的平台可以登出。 */
export type LibraryLogoutRejectReason = 'unknown-provider' | 'not-authenticated';

export type LibraryLogoutResult =
    | { status: 'logged-out'; providerId: OnlineProviderId }
    /** 用的人在确认框里取消了。 */
    | { status: 'cancelled'; providerId: OnlineProviderId }
    | { status: 'rejected'; providerId: OnlineProviderId; reason: LibraryLogoutRejectReason }
    | { status: 'busy'; providerId: OnlineProviderId }
    | { status: 'failed'; providerId: OnlineProviderId; message: string };

/** 同步被拒的原因（core/account/accountRules 的 resolveAccountSyncEligibility）：只有有账号的平台可以同步。 */
export type LibraryAccountSyncRejectReason = 'unknown-provider' | 'not-signed-in';

/**
 * 同步账户数据的结局：读到了是 synced；平台说登录已经失效（账号离开了）是 ran-out；其余没读成的是 failed。
 * 没有账号的平台被拒（同步途中这个平台被退出了也是）；已经有一个在同步时是 busy。
 */
export type LibraryAccountSyncResult =
    | { status: 'synced'; providerId: OnlineProviderId }
    | { status: 'ran-out'; providerId: OnlineProviderId }
    | { status: 'failed'; providerId: OnlineProviderId }
    | { status: 'rejected'; providerId: OnlineProviderId; reason: LibraryAccountSyncRejectReason }
    | { status: 'busy'; providerId: OnlineProviderId };

// ─── controller ─────────────────────────────────────────────────────────

/**
 * 在线账户的 controller：App 创建（换 suite 不重建），suite、登录窗口与 AccountTab 经 props 拿到它。
 * 快照对象在没有变化时保持身份（useSyncExternalStore 友好）；所有动作返回判别式结果，UI 自己翻译。
 */
export interface LibraryAccountController {
    getSnapshot(): LibraryAccountSnapshot;
    subscribe(listener: () => void): () => void;
    /** 选平台：未配置 → unavailable；能直接切（已登录 / 无账户）→ requestSwitch；否则 login（调用的人打开登录窗口）。 */
    selectProvider(providerId: OnlineProviderId): Promise<LibrarySelectProviderResult>;
    /** 同平台直接 switched；否则直接切：离开旧平台（退出私人 FM，队列留着）→ 作废在途请求 → 写当前平台 → 读新账户。 */
    requestSwitch(providerId: OnlineProviderId): Promise<LibrarySwitchResult>;
    /** 待确认切换的确认与取消：眼下没有待确认的切换，一律返回 stale。 */
    confirmSwitch(requestId: number): Promise<LibrarySwitchConfirmResult>;
    cancelSwitch(requestId: number): LibrarySwitchCancelResult;
    /**
     * 只由登录窗口调用。先停旧会话；解析登录方式（带竞态代次）：声明了多种方式的先停在 choosing-method ——
     * 其中指向一张密码表单的方式，选定之后停在表单那一步；在浏览器里确认的停在 ready，其余直接要码。
     */
    startLogin(providerId: OnlineProviderId): Promise<LibraryStartLoginResult>;
    /** 提交一次用户名密码登录（飞牛这类自建服务）。成功走与扫码确认同一条收尾：刷新账户 → 收起（必要时问激活）。 */
    submitPasswordLogin(credentials: PasswordLoginCredentials): Promise<LibraryPasswordLoginResult>;
    /** 用这种方式（重新）开始；任何阶段都可以换。 */
    selectLoginMethod(methodId: string): Promise<LibraryLoginRequestResult>;
    /** 保留已选的登录方式开始或重来：ready（打开浏览器）、expired、error 时可用，等待再试的时刻之前被拒。 */
    retryLogin(): Promise<LibraryLoginRequestResult>;
    /** 在浏览器里确认的登录：让 provider 在系统浏览器里把登录的页面再打开一次。 */
    openLoginPage(): Promise<LibraryLoginPageResult>;
    /** 停轮询、keyed 取消会话、清快照。 */
    closeLogin(): LibraryLoginCloseResult;
    /** 重启登录要靠的本地服务；起来了接着登录。 */
    restartLocalService(): Promise<LibraryLocalServiceRestartResult>;
    buildLoginDiagnosticReport(): Promise<LibraryLoginDiagnosticResult>;
    /**
     * 表单式登录完成（FormLogin 提交成功后由登录窗口调用）：读账号，走和扫码确认一样的收尾链路——
     * 读到了收起登录，不是当前平台时先问（activate-after-login），再报完成（登录窗口据它放动画/关窗）。
     * 表单登录没有会话，sessionId 为 0。
     */
    completeFormLogin(providerId: OnlineProviderId): Promise<LibraryLoginCompletion>;
    /**
     * 表单式登录完整链路（FormLogin 提交时调用）：先提交表单（provider 的 submitLoginForm，失败抛错由表单显示），
     * 成功后读账号、走和扫码确认一样的收尾链路，返回完成结局。读账号失败（refresh-failed）：token 已存，
     * 登录窗口据结局显示提示而不是静默。
     */
    submitFormLogin(providerId: OnlineProviderId, values: Record<string, string>): Promise<LibraryLoginCompletion>;
    /** 只对已登录的平台；先经宿主问用的人，答应后把这个平台的歌移出播放器，再走宿主注入的登出。 */
    logout(providerId: OnlineProviderId): Promise<LibraryLogoutResult>;
    /** 只对有账号的平台：重新读它的账号、歌单与红心（面板账户页与登录窗口账号那一幅的「同步数据」）。 */
    syncAccount(providerId: OnlineProviderId): Promise<LibraryAccountSyncResult>;
    /** 从账号那一幅打开这个平台的配置清单（先停下正在进行的登录）。 */
    openSetup(providerId: OnlineProviderId): Promise<LibrarySetupOpenResult>;
    /** 做开着的清单上的一个操作；value 是密码框交出的内容。 */
    runSetupAction(stepId: string, actionId: string, value?: string): Promise<LibrarySetupActionResult>;
    /** 收起清单。登录之后的那一份：再报这一次登录的完成（登录窗口据它放动画、关窗）。 */
    finishSetup(): Promise<void>;
    /** 宿主卸载：关闭登录会话（keyed 取消），待确认切换按 declined / disposed 结算。 */
    dispose(): void;
}

// ─── 端口（默认装配见 core/account/providerAccountDeps.service） ──────────────

/**
 * 登录的 auth 端口：除 dropRequestLimits 外签名与 omni 的同名方法一致（默认装配转给 omni）。
 * getProviderCapabilities 只用到 auth，omni 返回的完整能力可以直接传。
 */
export type LibraryAccountAuthPort = {
    /** 没有 auth 的 provider 回空数组。 */
    resolveLoginMethods(providerId: OnlineProviderId): Promise<LoginMethod[]>;
    /** 扫码的回二维码图片；在浏览器里确认的回空串。 */
    startLogin(providerId: OnlineProviderId, methodId?: string): Promise<{ key: string; imageUrl: string }>;
    checkLogin(providerId: OnlineProviderId, key: string): Promise<LoginState>;
    /** 只释放这一把 key，幂等；调用方 fire-and-forget。 */
    cancelLogin(providerId: OnlineProviderId, key: string): Promise<void>;
    confirmsLoginInBrowser(providerId: OnlineProviderId): boolean;
    opensLoginPageItself(providerId: OnlineProviderId, key: string): boolean;
    openLoginPage(providerId: OnlineProviderId, key: string): Promise<void>;
    /** 声明了这一次登录的有效期才由前端计时；null 表示只认平台报的过期。 */
    getLoginTtlMs(providerId: OnlineProviderId): number | null;
    getLoginTexts(providerId: OnlineProviderId): LoginTexts | null;
    getLoginLocalService(providerId: OnlineProviderId): LoginLocalService | null;
    /** 自己不会失败（omni 把 provider 的错误写成一行）。 */
    getLoginDiagnostics(providerId: OnlineProviderId): Promise<LoginDiagnosticLine[]>;
    /** 此刻能不能主动自检（同步回答，界面据此决定要不要显示「正在检查」）。 */
    canRunLoginSelfCheck(providerId: OnlineProviderId): boolean;
    /** 主动自检；没有可检查的对象时 resolve null，自检本身出错时 reject。 */
    runLoginSelfCheck(providerId: OnlineProviderId): Promise<LoginSelfCheckResult | null>;
    /** 用户名密码登录（飞牛这类自建服务）；provider 没有这个能力时由调用方先按能力判定拦住。 */
    loginWithPassword(providerId: OnlineProviderId, credentials: PasswordLoginCredentials): Promise<ProviderUser | null>;
    /** 密码登录表单的预填值（上次填过的服务器地址）；按选中的登录方式问，没有时为 null（而不是每次新建的空对象）。 */
    getPasswordLoginDefaults?(providerId: OnlineProviderId, methodId?: string | null): { serverUrl?: string } | null;
    getProviderCapabilities(providerId: OnlineProviderId): Pick<ProviderCapabilities, 'auth' | 'passwordLogin' | 'passwordLoginServerUrl'>;
    /** 读到账号之后还要不要多查一步（同步回答，步骤标记据此多一格）。 */
    checksAfterLogin(providerId: OnlineProviderId): boolean;
    /** 登录之后的检查：回配置清单或 null；可能 reject。 */
    checkAfterLogin(providerId: OnlineProviderId, methodId: string | null): Promise<ProviderSetupView | null>;
    hasSetup(providerId: OnlineProviderId): boolean;
    getSetup(providerId: OnlineProviderId): Promise<ProviderSetupView | null>;
    runSetupAction(providerId: OnlineProviderId, stepId: string, actionId: string, value?: string): Promise<ProviderSetupView>;
    /** 此刻还在计时的登录请求不再计时（services/onlineMusic/login/loginRequestLimit）；停下一次登录时调。 */
    dropRequestLimits(): void;
};

/**
 * 账户读写端口：provider 列表与当前平台。默认装配读 omni.getProviderSummaries 与 useOnlineProviderAccountStore，
 * subscribe 同时听账户 store 与 omni.subscribeProviders（mod 源增删）。
 */
export type LibraryAccountStorePort = {
    listProviders(): ProviderAccountSummary[];
    /** 平台名（omni.getProviderLabel：shortName → displayName → id）。 */
    getProviderLabel(providerId: OnlineProviderId): string;
    /** store 里存的当前平台（未经回落）。 */
    getStoredActiveProviderId(): OnlineProviderId;
    setActiveProviderId(providerId: OnlineProviderId): void;
    /** 写新的当前平台之前作废上一个平台的在途请求（omni.invalidateActiveRequests）。 */
    invalidateActiveRequests(): void;
    subscribe(listener: () => void): () => void;
};

/** 读账号的时机：登录确认之后、切到这个平台之后、用的人按了「同步数据」。 */
export type LibraryAccountRefreshReason = 'sign-in' | 'switch' | 'sync';

/**
 * 账户的读、退出与退出前的那一问。默认装配：读账号走 omni.readAccount（services/onlineMusic/account/accountRead），
 * 退出与那一问由宿主给（App 的 useProviderSignOut：确认框、退出之后的提示）。
 * 函数形状而不是记录：宿主可以用 ref 指向每次渲染的最新实现，controller 不必重建。
 */
export type LibraryProviderAccountPort = {
    /** 读这个平台的账号；sign-in 时回 false 表示确认了却没有人登录着（失败），sync 时回 false 表示没读全。从不 reject。 */
    refresh(providerId: OnlineProviderId, reason: LibraryAccountRefreshReason): Promise<boolean>;
    /** 提交表单式登录（FormLogin 渲染的字段，走 provider 的 submitLoginForm）。失败抛错，由表单显示。 */
    submitLoginForm(providerId: OnlineProviderId, values: Record<string, string>): Promise<void>;
    /** 退出这个平台的登录：账号离开、平台被告知、存着的账号去掉。 */
    logout(providerId: OnlineProviderId): Promise<void>;
    /** 退出之前问用的人；removesSongs：播放器里有这个平台的歌（退出时会被移出）。回 false 就不退。 */
    confirmLogout(request: { providerId: OnlineProviderId; removesSongs: boolean }): Promise<boolean>;
};

/**
 * 平台换了时的播放器端口（app/createLibraryAccountPort）。播放、歌词、红心都按歌曲自己的平台走，所以一个队列里
 * 可以有几个平台的歌：切到别的平台不动队列，退出一个平台只拿走它自己的歌。
 */
export type LibraryProviderSwitchCleanupPort = {
    /** 切到别的平台之前：放下只跟着当前平台走的东西（私人 FM 模式、集合导航）；队列与正在放的歌留着。 */
    leaveProvider(previousProviderId: OnlineProviderId, nextProviderId: OnlineProviderId): void | Promise<void>;
    /** 播放器里有没有这个平台的歌（正在放的或队列里的）：有才在退出前的那一问里提一句。 */
    holdsSongsOf(providerId: OnlineProviderId): boolean;
    /** 退出这个平台：把它的歌移出队列，正在放的是它的就停下；别的歌留着。 */
    dropSongsOf(providerId: OnlineProviderId): void | Promise<void>;
};

/** 计时器句柄：由时钟端口自己解释（浏览器是数字，测试里可以是任何东西）。 */
export type LibraryTimerHandle = unknown;

/** 时钟端口：轮询间隔、有效期、已扫码的时限与诊断时间线都经它，测试注入假时钟。 */
export type LibraryAccountClock = {
    now(): number;
    setTimeout(callback: () => void, ms: number): LibraryTimerHandle;
    clearTimeout(handle: LibraryTimerHandle): void;
};

/** 诊断报告的环境信息（__APP_VERSION__、navigator.userAgent、构建来源、网页版的站点）。 */
export type LibraryLoginDiagnosticsEnvironment = {
    appVersion: string | null;
    userAgent: string;
    /** 报告里的 build 行（官方 / 非官方构建与来源仓库）；不传时报告不带这一行。 */
    build?: string | null;
    /** 网页版所在站点的 origin（区分是谁部署的）；桌面版为 null。 */
    origin?: string | null;
};

/** 会话事件的日志出口（默认打到 console，前缀 [ProviderLogin]，同时进诊断时间线）。 */
export type LibraryAccountLogger = (
    level: 'info' | 'warn',
    event: string,
    detail: Record<string, unknown>,
) => void;

/** 账户 controller 的全部依赖。 */
export type LibraryAccountControllerDeps = {
    auth: LibraryAccountAuthPort;
    accounts: LibraryAccountStorePort;
    providerAccounts: LibraryProviderAccountPort;
    switchCleanup: LibraryProviderSwitchCleanupPort;
    clock: LibraryAccountClock;
    diagnostics: LibraryLoginDiagnosticsEnvironment;
    log?: LibraryAccountLogger;
};

// ─── account surface ────────────────────────────────────────────────────

/**
 * account surface 的语义动作（suite 在 entry 的 `surfaces.account` 里声明，LibrarySurfaceId 含 'account'）。
 * 登录本身画在登录窗口里（src/components/login，首页外壳挂一个，所有 suite 共用）：suite 只从自己的界面打开它
 * （loginWindowStore 的 openLoginWindow），account surface 画的是待确认切换。确认会阻塞流程，account surface
 * 整体回退：当前 suite 没有它就用 grid 的；基础动作缺一个就是清单错误：建 suite 索引时抛错（core/suite/librarySuites
 * 的 LIBRARY_ACCOUNT_REQUIRED_ACTION_IDS），不会悄悄回退。
 *
 * | LibraryAccountActionId | 分级 | 说明 |
 * | --- | --- | --- |
 * | account-login | 基础 | 打开登录窗口（二维码或浏览器、状态、重来、关闭都在窗口里） |
 * | account-login-method | 基础（有多方式的 provider 才用到） | QQ 两步式，在窗口里选 |
 * | account-switch-confirm | 基础 | 确认 / 取消待确认切换 |
 * | account-select / account-logout | 推荐 | 首页上的账户列表（选平台、登出入口） |
 * | account-login-diagnostics | 可选 | 失败后的详情与诊断报告（窗口里） |
 * | account-backend-restart | 可选 | 本地服务没起来时重启（窗口里） |
 */
export type LibraryAccountActionId =
    | 'account-login'
    | 'account-login-method'
    | 'account-switch-confirm'
    | 'account-select'
    | 'account-logout'
    | 'account-login-diagnostics'
    | 'account-backend-restart';

/** 渲染 account surface 的那套 suite 声明的动作（与 suite.ts 的 LibraryDeclaredActions 同形，动作是账户的）。 */
export type LibraryAccountDeclaredActions = {
    readonly actions: readonly LibraryAccountActionId[];
    readonly extraActions: readonly string[];
};

/** account surface 的输入：只在 pendingSwitch 非空时渲染内容（眼下切换不再确认，它总是空的）。 */
export type LibraryAccountSurfaceProps = {
    account: LibraryAccountController;
    theme: Theme;
    isDaylight: boolean;
    /** 只有用户正看着的那一层可交互（键盘）。 */
    isInteractive: boolean;
    declaredActions: LibraryAccountDeclaredActions;
};
