package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import top.izuna.foliamajor.coloros.ColorOsLyricBridge;

/**
 * 后台播放的前台服务。
 *
 * 为什么必须有它：Folia 的播放器是 WebView 里的 &lt;audio&gt;，应用切到后台后，
 * Android 会节流 WebView 的 JS 定时器与网络栈。表现就是「当前这首还在放，
 * 但自动切下一首时 fetch 拿不到歌曲地址」。系统并没有断网——是请求被挂起了。
 *
 * 两个手段一起用才对：
 * 1. startForeground 让进程拿到前台优先级，Doze/后台限制下网络与 CPU 不被节流，
 *    WebView 里的 fetch 才能正常完成；
 * 2. MediaSessionCompat 挂出系统媒体通知（锁屏与通知栏可见），
 *    这是用户说的「注册一个音乐播放的通知」。它同时让系统媒体按键、
 *    蓝牙耳机与车机按键能控制播放——这些是 navigator.mediaSession 在 WebView 里做不到的。
 *
 * 音频本身仍由 WebView 播放，这里只负责「进程别被掐 + 通知可见可控制」。
 */
public class FoliaPlaybackService extends android.app.Service {

    private static final String TAG = "FoliaPlaybackService";
    private static final String CHANNEL_ID = "folia_playback";
    private static final int NOTIFICATION_ID = 0x1F01;

    private MediaSessionCompat mediaSession;
    private NotificationManager notificationManager;

    /**
     * 服务是否还活着。
     *
     * 插件侧要靠它判断「有没有必要把服务拉起来」：原先无歌/暂停也会
     * startForegroundService，于是打开应用就起一个前台服务。
     */
    private static volatile boolean running = false;

    /** 服务是否还活着。public：coloros 包要判断「有没有必要发刷新 intent」。 */
    public static boolean isRunning() {
        return running;
    }

    /**
     * 服务是否**已经在前台**（通知已经贴出去了）。public：插件要靠它选 startService
     * 还是 startForegroundService —— 已在前台时再走 startForegroundService，服务端
     * 就得每秒再调一次 startForeground() 去兑现那道倒计时（见 promoteToForeground）。
     */
    public static boolean isForegrounded() {
        return foregrounded;
    }

    // 通知内容缓存：metadata 与 playbackState 是两次独立更新，
    // 每次都基于这些字段重建整条通知，而不是互相覆盖。
    private String cachedTitle = "";
    private String cachedArtist = "";
    private String cachedAlbum = "";
    private Bitmap cachedArtwork;
    /** 上一首歌的身份（Web 层给的 songKey），用来判断这次 update 是不是换歌了。 */
    private String cachedSongKey = null;
    private int cachedState = PlaybackStateCompat.STATE_NONE;
    private long cachedDurationMs = 0L;
    private long cachedPositionMs = 0L;
    private float cachedSpeed = 1.0f;
    private boolean cachedPlaying = false;
    /**
     * 当前这首歌是不是「已喜欢」。
     *
     * Web 层每次推 metadata 都会带上它。通知栏那颗心的**形状**（实心 / 空心）与
     * MediaSession 的「喜欢」按钮标题都读这里 —— 原生不自己记状态，点了只发命令，
     * 真正改状态的是 Web 层，改完再推回来。
     */
    private boolean cachedLiked = false;
    /**
     * 「喜欢」这个动作当前能不能用（平台不支持收藏、正由外部 Stage 播放时为 false）。
     *
     * false 时通知栏不画那颗心：通知按钮没有「置灰」这一说，画出来点了没反应比不画更糟。
     */
    private boolean cachedCanLike = false;
    /** 封面角标（通知 small icon）的资源 id；0 = 还没收到过，用缺省。 */
    private int cachedBadgeRes = 0;
    /**
     * 已经调用过 startForeground 了；见 promoteToForeground()。
     *
     * 静态 + volatile 是给插件那边读的（isForegrounded）：它要在发 intent 之前知道
     * 服务在不在前台，决定用 startService 还是 startForegroundService。
     */
    private static volatile boolean foregrounded = false;
    /** 最近一次交给系统的通知：promoteToForeground() 重复贴的就是它，省掉重建的开销。 */
    private Notification cachedNotification;

    /**
     * 「按下播放」之后，等 Web 层确认真的播起来了的宽限期（毫秒）。
     *
     * Web 层那条路不一定一步就到：长时间暂停之后，音频上下文要 resume、在线歌的播放地址
     * 可能已经过期要重新取一次，这两件事在后台都可能挂住（用户原话：暂停很久之后点播放，
     * 拉不起来，打开应用才瞬间恢复）。而我们在 {@link #onPlay()} 里为了「后台也能让
     * 壁纸/叠层跟着走」已经把锚点切成在播了 —— 等不到确认的话，壁纸、叠层、状态栏歌词
     * 会一路往外推，实际一点声音都没有。所以给一个宽限期，到时还没确认就冻回去。
     */
    private static final long PLAY_CONFIRM_GRACE_MS = 4000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** 有一次「乐观播放」在等确认。 */
    private boolean playConfirmPending = false;
    /** 那次乐观播放切的那一刻的位置：冻回去要落在这儿，不能落在已经被推出去的地方。 */
    private long playConfirmAnchorMs = 0L;
    /** 一次「按下播放」最多补发几次。补发不是死循环：试过一次还起不来就不再打扰 Web 层。 */
    private static final int MAX_PLAY_NUDGES = 1;
    private int playNudges = 0;
    private final Runnable playConfirmCheck = new Runnable() {
        @Override
        public void run() {
            if (!playConfirmPending) return;
            playConfirmPending = false;
            // Web 层已经回过话（无论是 playing 还是 paused）：以它为准，这里什么都不做。
            if (cachedPlaying) return;
            top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(playConfirmAnchorMs, false);
            top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                    .shared(FoliaPlaybackService.this).invalidateOverlay();
            /*
             * 补发一次播放命令。
             *
             * 这段时间里 Web 层一个字都没回，多半是**卡在某个 await 上**而不是「播不了」：
             * 最典型的是长时间暂停之后那条「在线地址过期、重新取一次」的网络往返 ——
             * 后台里它可以一直不落地，于是整条 resume 停在那儿，用户看到的就是
             * 「按了播放没反应，打开应用才瞬间恢复」。
             *
             * 补发为什么有用：第二次 resume 会撞上 `recoverOnlinePlaybackSource` 自己的去重
             * （同一个 failedSrc 已经登记过就直接返回），于是它跳过这一步、直接
             * `audio.play()` 现有地址 —— 多数情况下声音这就出来了。
             *
             * 为什么必须是原生计时器而不是 JS 的 setTimeout：这个应用退到后台后 JS 定时器
             * 会被系统挂起（壁纸歌词正是因此才改成「锚点 + 墙钟」），JS 那边根本没有
             * 可靠的钟可用；而桥本身是通的 —— 命令就是这么送过去的。
             */
            if (playNudges < MAX_PLAY_NUDGES) {
                playNudges++;
                Log.w(TAG, "Play command never took effect; nudging the web layer ("
                        + playNudges + "/" + MAX_PLAY_NUDGES + ")");
                sendCommand("play");
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        // 新实例起来了：前台状态必须从零算。它是静态的，进程活着时插件读它
        // （isForegrounded）决定走 startService 还是 startForegroundService；留着上一个
        // 实例的 true，新实例就会以为自己已经前台化、跳过 startForeground() ——
        // 5 秒后系统抛 ForegroundServiceDidNotStartInTimeException 杀进程。
        foregrounded = false;
        cachedNotification = null;
        createNotificationChannel();
        // 就地前台化，**在任何可能卡住的工作之前**。
        //
        // Android 要求 startForegroundService() 之后 5 秒内调用 startForeground()，
        // 超时就抛 ForegroundServiceDidNotStartInTimeException 直接杀进程。
        // 放在 onCreate 里而不是等 onStartCommand 走完分支是最稳的做法（无论后续 switch
        // 走进哪个分支、甚至 intent 为 null，前台化都已经完成了）；而它必须在
        // ensureMediaSession() 之前 —— 建 MediaSession 要跟系统的媒体服务打交道，
        // 主线程一忙起来（切登录平台时 WebView 正在重载）就把这 5 秒耗掉了。
        // MediaSession 建好之后再重贴一次通知，好让它带上 MediaStyle 的 token。
        promoteToForeground();
        ensureMediaSession();
        publishNotification();
    }

    /**
     * 建立/重建 MediaSession。
     *
     * 抽成方法是因为进程被杀后 START_STICKY 只会重跑 onStartCommand，
     * 不会经过 onCreate，MediaSession 会是 null（通知上的控制项也就没了）。
     */
    private void ensureMediaSession() {
        if (mediaSession != null) {
            return;
        }
        mediaSession = new MediaSessionCompat(this, "FoliaPlayback");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                /*
                 * 原生播放（P1）：命令同时**直接**给原生播放器一份。
                 *
                 * 老路是「广播 → 插件 → JS → resumePlayback」，而挂了很久之后 WebView 那侧的
                 * JS 会被节流甚至整个挂起 —— 用户原话：「长时间暂停后，通知中心点播放还是
                 * 拉不起来」。原生这一路不吃那条限制。JS 那条命令照样发：界面、歌词、
                 * 以及 Web 那条链路还得靠它。两边各管一半，重复一次 play 不会有副作用。
                 */
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.resumeFromSystem();
                } catch (Throwable ignored) {
                    // 原生播放器不在（没开原生播放 / 插件没编进来）：交给 Web 那条路。
                }
                sendCommand("play");
                /*
                 * 锚点**这里就切回播放**，不等 Web 层回话 —— 原因见 onSeekTo 那条注释。
                 *
                 * 具体到这里：通知栏的播放/暂停是**在后台**按下的，而后台 WebView 的 JS
                 * 定时器会被系统挂起，`useLyricsWallpaperFeed` 里负责推 playing 的那几个
                 * effect 一个都跑不起来。壁纸那一侧是「锚点 + 墙钟」自己往前推的，
                 * 缺这一次同步，它就一直冻在暂停那个锚点上 —— 表现就是
                 * 「暂停后重新播放，歌词进度不动」（用户原话）。
                 *
                 * 但「按下播放」不等于「真的播起来了」：所以同时记下这一刻的位置，并挂一个
                 * 宽限检查（见 PLAY_CONFIRM_GRACE_MS）。Web 层真起来了会推 playing 回来，
                 * 那一次就把检查作废；没起来就把锚点冻回去 —— 否则就是用户看到的
                 * 「状态栏、叠层的进度一直在走，实际一点声音都没有」。
                 */
                playConfirmAnchorMs = clampedAnchorPosition();
                playConfirmPending = true;
                // 这是用户新按下的一次播放：允许再补发一次。
                playNudges = 0;
                mainHandler.removeCallbacks(playConfirmCheck);
                mainHandler.postDelayed(playConfirmCheck, PLAY_CONFIRM_GRACE_MS);
                syncWallpaperAnchor(true);
            }

            @Override
            public void onPause() {
                // 同上（见 onPlay 那条注释）：直接停原生播放器，别只指望后台里那侧 JS。
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.pauseFromSystem();
                } catch (Throwable ignored) {
                    // 同上。
                }
                sendCommand("pause");
                // 暂停按下就撤回那次乐观播放的确认：方向相反，不需要再等，也不会再补发。
                playConfirmPending = false;
                playNudges = 0;
                mainHandler.removeCallbacks(playConfirmCheck);
                // 同上，方向相反：不在这里冻结，壁纸会按 playing=true 一路外推到时间轴
                // 尽头，那一句歌词就永远停在那儿 —— 这时候再点播放也回不来了，
                // 因为锚点早就飞出去了。
                syncWallpaperAnchor(false);
            }

            @Override
            public void onSkipToNext() {
                sendCommand("next");
            }

            @Override
            public void onSkipToPrevious() {
                sendCommand("previous");
            }

            /**
             * 通知栏进度条被拖动。
             *
             * 光有 ACTION_SEEK_TO 还不够：系统只在 actions 里看到它时才把那条
             * 进度条画成可拖的样子，真正拖完之后调的就是这里。位置以毫秒传回 Web 层，
             * 由那边去 seek 音频 —— 原生不自己碰播放器。
             */
            @Override
            public void onSeekTo(long pos) {
                sendCommand("seek", pos);
                /*
                 * 壁纸 / 悬浮窗那边的锚点**这里就对齐**，不等 Web 层回话。
                 *
                 * 不能指望 Web 层那条 seek 检测（`useLyricsWallpaperFeed` 里的轮询）：
                 * App 退到后台之后 WebView 的 JS 定时器会被系统挂起，而拖通知栏进度条
                 * 恰恰就是在后台发生的 —— 那条路一挂，锚点永远不更新，歌词就停在原地。
                 *
                 * 更糟的是原生这边还在按**旧**锚点往前外推：拖回开头之后它还会一路
                 * 算到歌曲末尾，于是整句被判成唱完、整行颜色一下填满，
                 * 等 Web 层终于推来一次锚点才弹回去 —— 就是那个「闪一下」。
                 */
                boolean playing = cachedState == PlaybackStateCompat.STATE_PLAYING;
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(pos, playing);
                top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                        .shared(FoliaPlaybackService.this).invalidateOverlay();
            }

            @Override
            public void onStop() {
                sendCommand("stop");
                if (mediaSession != null) {
                    mediaSession.setActive(false);
                }
                stopForegroundCompat();
                stopSelf();
            }

            /**
             * 「喜欢 / 取消喜欢」。
             *
             * 系统媒体控制器（锁屏、Android Auto、蓝牙与车机）按下我们自己声明的那颗心时
             * 走这里。原生**不自己改 cachedLiked** —— 真正知道这首歌在各平台「我喜欢」里
             * 是什么状态的只有 Web 层（本地歌、Navidrome、各家在线平台各一套），点了只发
             * 命令，等那边把新状态推回来（见 updateMetadata）。
             *
             * 提前把 cachedLiked 翻过来的话，请求失败时通知栏会一直停在错的状态上，
             * 而且没有任何东西会再来纠正它。
             */
            @Override
            public void onCustomAction(String action, android.os.Bundle extras) {
                if (ACTION_TOGGLE_LIKE.equals(action)) {
                    sendCommand("like");
                }
            }
        });
        mediaSession.setActive(true);
        // 通知栏的播放/暂停等动作直接复用 MediaSession 的控制，不再各自维护一套。
        mediaSession.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(supportedActions())
                .setState(PlaybackStateCompat.STATE_NONE, 0, 1.0f)
                .build());
    }

    /**
     * 把「播 / 停」立刻同步给壁纸与悬浮小窗那一侧，不等 Web 层回话。
     *
     * 通知栏的播放 / 暂停是**在后台**按下的，而后台 WebView 的 JS 定时器会被系统挂起，
     * `useLyricsWallpaperFeed` 里负责推 playing 的那几个 effect 一个都跑不起来，
     * 命令发出去之后没人替壁纸更新状态。原生这一侧是「锚点 + 墙钟」自己往前推的，
     * 所以漏一次同步就再也回不来：
     *   暂停漏了 → 按 playing=true 一路外推到时间轴尽头，那一句歌词停在那儿；
     *   播放漏了 → 冻在旧锚点上，进度纹丝不动。
     *
     * 位置取壁纸侧**此刻自己算出来的那个**（屏幕上正在显示的就是它，接着它走才不会跳），
     * 再夹进 [0, 时长]：万一已经跑飞了，至少先落回一个合法位置。
     */
    private void syncWallpaperAnchor(boolean playing) {
        top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(clampedAnchorPosition(), playing);
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(this).invalidateOverlay();
    }

    /**
     * 壁纸那一侧**此刻自己算出来**的位置，夹进 [0, 时长]。
     *
     * 屏幕上正在显示的就是它，接着它走才不会跳；万一已经跑飞了（暂停没同步、被外推到
     * 时间轴尽头），至少先落回一个合法位置。
     */
    private long clampedAnchorPosition() {
        top.izuna.foliamajor.wallpaper.WallpaperLyricsState.Snapshot snapshot =
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.get();
        long position = snapshot.positionMs();
        if (snapshot.durationMs > 0L && position > snapshot.durationMs) {
            position = snapshot.durationMs;
        }
        if (position < 0L) {
            position = 0L;
        }
        return position;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 无条件先兑现一次前台化：startForegroundService 开的那道 5 秒倒计时**不看 intent**，
        // 而服务已经存在时 onCreate 不会再跑（promoteToForeground 里那句「已前台就返回」
        // 让它几乎没有开销）。放在 action 判断里面的话，一条没带 action 的
        // startForegroundService 就永远等不到 startForeground()。
        promoteToForeground();
        String action = intent == null ? null : intent.getAction();
        if (action != null) {
            switch (action) {
                case ACTION_UPDATE_METADATA:
                    updateMetadata(intent);
                    break;
                case ACTION_UPDATE_STATE:
                    updatePlaybackState(intent);
                    break;
                case ACTION_REFRESH_METADATA:
                    // ColorOS 原生歌词到的比播放晚（Web 层先拿到词）时用这条：
                    // 只按缓存重建 metadata 与 PlaybackState，不动前台化状态。
                    applyMetadata();
                    applyPlaybackState();
                    break;
                case ACTION_STOP_FOREGROUND:
                    stopForegroundCompat();
                    stopSelf();
                    return START_NOT_STICKY;
                default:
                    break;
            }

            // 重建 MediaSession：进程被杀后 START_STICKY 只会重跑 onStartCommand，
            // 不会走 onCreate 的初始化路径。
            ensureMediaSession();
            // 内容变了，通知要跟着重建（前台化本身在 onCreate 就已经完成）。
            promoteToForeground();
        }
        // START_STICKY：进程被系统回收后（仍处于播放状态）尽量重建服务。
        return START_STICKY;
    }

    @Override
    public android.os.IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        // 实例要没了：那次等确认的检查也跟着撤掉（它持着 this）。
        playConfirmPending = false;
        mainHandler.removeCallbacks(playConfirmCheck);
        // 实例没了，前台状态必须跟着清：它是静态的，进程还在时插件靠它选
        // startService / startForegroundService。留着 true 会让下一次创建的实例跳过
        // startForeground()，而那条路是 startForegroundService 开的 —— 5 秒后就是
        // ForegroundServiceDidNotStartInTimeException。（onCreate 里也重置一次，双保险。）
        foregrounded = false;
        cachedNotification = null;
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    /**
     * 把 JS 侧的播放/切歌意图转回 WebView。
     *
     * 用广播而不是直接调 Bridge：Service 与 Activity 是不同组件，
     * BridgeActivity 的实例可能已随后台被回收，广播由注册在 WebView 侧的
     * Capacitor Bridge 插件接收，无论 Activity 是否还在都能收到。
     */
    private void sendCommand(String command) {
        // 必须写死组件名：Android 8+ 的隐式广播不会投递给清单注册的接收器。
        Intent intent = new Intent(this, FoliaCommandReceiver.class);
        intent.setAction(ACTION_WEB_COMMAND);
        intent.putExtra(EXTRA_COMMAND, command);
        sendBroadcast(intent);
    }

    /** 带位置的命令（目前只有拖动进度条的 seek 用得到）。 */
    private void sendCommand(String command, long positionMs) {
        Intent intent = new Intent(this, FoliaCommandReceiver.class);
        intent.setAction(ACTION_WEB_COMMAND);
        intent.putExtra(EXTRA_COMMAND, command);
        intent.putExtra(EXTRA_COMMAND_POSITION, positionMs);
        sendBroadcast(intent);
    }

    /**
     * 通知栏支持哪些动作。
     *
     * ACTION_SEEK_TO 是那条进度条的关键：系统只在 actions 里看到它时，才把进度条
     * 画成可拖的；没有它，进度条要么不出现，要么就是一条点不动的灰条。
     */
    private static long supportedActions() {
        return PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_SEEK_TO;
    }

    /**
     * 把服务顶到前台。
     *
     * 通知构造失败不该把整个应用带走：startForeground 抛异常意味着
     * 系统判定「前台服务没起来」，紧接着就是进程被杀，用户看到的就是闪退。
     * 这里兜住异常，宁可没有通知也要保住播放。
     */
    private void promoteToForeground() {
        /*
         * 已经在前台就直接返回 —— 这里有守卫是**省掉一整笔开销**，不是偷懒：
         *
         * startForeground() 会把通知整个跨进程交给系统，通知里带着 512×512 的封面
         * Bitmap（约 1 MB）。而播放位置是每秒推一次的，没有这道守卫就等于每秒
         * 在主线程上搬一次 1 MB —— 播放页单帧本来就要二三十毫秒，被它定期拖一下
         * 就成了肉眼可见的卡顿。
         *
         * 那「每一条 startForegroundService 都要在 5 秒内 startForeground() 兑现」
         * 这条怎么办？由**发送方**负责：FoliaPlaybackPlugin 只在服务还没前台时才用
         * startForegroundService（见 startServiceCompat），服务已经在前台时改走普通
         * startService —— 那条路不会开倒计时，也就不需要在这里兑现。
         */
        if (foregrounded) {
            return;
        }
        /*
         * 先用**占位**通知把前台化兑现掉，再贴完整的那条。
         *
         * 分开是为了一个真崩过的堆栈：ForegroundServiceDidNotStartInTimeException ——
         * startForegroundService() 之后系统只给 5 秒，超时直接杀进程。而完整通知不是白来的：
         * 它要 getLaunchIntentForPackage()（PackageManager 的跨进程调用）和四个
         * PendingIntent.getBroadcast/getActivity（每次都要跟 system_server 打交道），
         * 冷启动时主线程正被 WebView 首帧与那一大包 JS 占满，系统侧一忙这些调用能排到秒级。
         * 「兑现」与「好看」就此分开：前者用一条什么都不带的通知，几乎零成本；
         * 后者再慢也无所谓 —— 倒计时已经不可能超时了。
         */
        try {
            startForeground(NOTIFICATION_ID, buildPlaceholderNotification());
            foregrounded = true;
        } catch (Throwable error) {
            Log.e(TAG, "startForeground failed; keeping the service alive without it", error);
            return;
        }
        // 前台化已经兑现，这里再抛异常也不会被系统杀掉，只是通知暂时不完整。
        try {
            cachedNotification = buildForegroundNotification();
            notificationManager.notify(NOTIFICATION_ID, cachedNotification);
        } catch (Throwable error) {
            Log.e(TAG, "Failed to build the playback notification", error);
        }
    }

    /**
     * 只够兑现前台化的最小通知：一个图标、一个标题，没有按钮、没有封面、不读 PackageManager。
     *
     * 存在的唯一理由就是上面那道 5 秒倒计时。内容随后必被 buildForegroundNotification()
     * 的完整通知覆盖（promoteToForeground 里前台化成功后立刻 notify 一次），
     * 所以它长什么样用户几乎看不到 —— 只在极端拥塞的冷启动里闪一下。
     */
    private Notification buildPlaceholderNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Folia")
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .build();
    }

    /**
     * 内容变了：重建通知并贴出去。
     *
     * 已经前台化时用 notify（不重复走 startForeground 那条路），没前台化时只把通知
     * 记下来，等 promoteToForeground() 再贴。
     */
    private void publishNotification() {
        try {
            cachedNotification = buildForegroundNotification();
            if (foregrounded) {
                notificationManager.notify(NOTIFICATION_ID, cachedNotification);
            }
        } catch (Throwable error) {
            Log.e(TAG, "Failed to build the playback notification", error);
        }
    }

    private void updateMetadata(Intent intent) {
        String title = intent.getStringExtra(EXTRA_TITLE);
        String artist = intent.getStringExtra(EXTRA_ARTIST);
        String album = intent.getStringExtra(EXTRA_ALBAND);
        String artworkBase64 = intent.getStringExtra(EXTRA_ARTWORK);
        String artworkUrl = intent.getStringExtra(EXTRA_ARTWORK_URL);
        long durationMs = intent.getLongExtra(EXTRA_DURATION, 0L);
        String providerBadge = intent.getStringExtra(EXTRA_PROVIDER_BADGE);
        String songKey = intent.getStringExtra(EXTRA_SONG_KEY);
        if (providerBadge != null) {
            cachedBadgeRes = providerIconRes(providerBadge);
        }

        // 换歌了：先把上一首的封面丢掉。
        //
        // 原来只在 decodeArtwork 拿到新图时才覆盖 cachedArtwork，于是「新封面还没到」和
        // 「这首歌没有封面」这两种情况都会让上一首的 Bitmap 一直挂着 —— 换歌那一刻 Web 层
        // 给的 base64 通常还是 null（封面要抓取 + 编码，慢一拍），通知栏就先画出上一首的
        // 封面，等下面按 URL 的下载跑完才换成当前歌。宁可中间没有大图，也不要错的图。
        boolean songChanged = songKey != null && !songKey.equals(cachedSongKey);
        if (songChanged) {
            cachedSongKey = songKey;
            cachedArtwork = null;
            // 时长也一起清掉：metadata 现在是从缓存整体重建的（见 applyMetadata），
            // 不清的话「新歌还没带时长」会被填成上一首的时长。
            cachedDurationMs = 0L;
            // 让这次的 artworkUrl 能重新触发下载（同一个地址在同一首歌里只下一次）。
            pendingArtworkUrl = null;
            // 「喜欢」是**这首歌**的属性，换歌时不能沿用上一首的：Web 层这一次 update
            // 里带的就是新歌的值，所以先清、紧接着下面再按 extras 覆盖。
            cachedLiked = false;
            cachedCanLike = false;
        }

        // 「喜欢」与否跟着 metadata 一起到：它是当前歌曲的属性，不是播放状态。
        // 用 hasExtra 而不是 getBooleanExtra 的缺省值 —— 缺省 false 会让「没带这个字段」
        // 和「带了 false」分不开，于是任何一次没带的 update 都会把已喜欢抹成未喜欢。
        if (intent.hasExtra(EXTRA_LIKED)) {
            cachedLiked = intent.getBooleanExtra(EXTRA_LIKED, false);
        }
        if (intent.hasExtra(EXTRA_CAN_LIKE)) {
            cachedCanLike = intent.getBooleanExtra(EXTRA_CAN_LIKE, false);
        }

        // 先更新缓存，再重建通知：metadata 与 state 是两次独立调用，
        // 任何一次都要能拿到完整的通知内容。
        if (title != null) cachedTitle = title;
        if (artist != null) cachedArtist = artist;
        if (album != null) cachedAlbum = album;
        if (durationMs > 0) cachedDurationMs = durationMs;
        Bitmap artwork = decodeArtwork(artworkBase64);
        if (artwork != null) {
            cachedArtwork = artwork;
        }
        publishSnapshot();
        applyMetadata();

        // 封面优先走原生下载：Web 层用 fetch 抓远端封面常常被 CORS 挡掉，
        // 通知栏就只剩一个默认图标。原生侧没有同源限制，拿到再补一次通知。
        if (artworkUrl != null && !artworkUrl.isEmpty()
                && !artworkUrl.equals(pendingArtworkUrl)) {
            pendingArtworkUrl = artworkUrl;
            fetchArtwork(artworkUrl);
        }

        // 已经贴出去的通知要再 post 一次才会带上新内容。
        // （promoteToForeground 只重复贴缓存里那条，不会顺手重建。）
        publishNotification();
    }

    /**
     * 用当前缓存的字段重建 metadata 并写回 MediaSession。
     *
     * 抽成方法是为了让「歌词到了」也能走同一条路（ACTION_REFRESH_METADATA）：
     * 歌词是 metadata 的**附加字段**，不是另一条通道，必须从同一份缓存整体重建，
     * 否则后到的那次会把先到的字段抹成空（封面的老问题就是这个）。
     */
    private void applyMetadata() {
        MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, cachedTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, cachedArtist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, cachedAlbum);
        if (cachedDurationMs > 0) {
            builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, cachedDurationMs);
        }
        if (cachedArtwork != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cachedArtwork);
        }
        // ColorOS 原生锁屏歌词：非 ColorOS 16+ 设备上 ColorOsLyricBridge 手里没有 payload，
        // 这里就是个空操作，不会往 metadata 里塞无用字段。
        ColorOsLyricBridge.attach(builder, cachedSongKey);

        if (mediaSession != null) {
            mediaSession.setMetadata(builder.build());
        }
    }

    /**
     * 上一次已经发起下载的封面地址，避免同一首歌反复下载。
     *
     * volatile：下载线程回来时要读它判断自己是不是已经过期了，而写发生在主线程。
     */
    private volatile String pendingArtworkUrl = null;

    private void fetchArtwork(final String url) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                Bitmap bitmap = downloadBitmap(url);
                // 下载期间可能已经切歌了：pendingArtworkUrl 已经换成新歌的地址，这张晚到的图要丢掉，
                // 否则会把上一首的封面贴到当前歌上。
                if (bitmap == null || !url.equals(pendingArtworkUrl)) {
                    return;
                }
                cachedArtwork = bitmap;
                publishSnapshot();
                // 封面补到了也顺手刷新一次 MediaSession：锁屏歌词页上的封面读的是 metadata，
                // 只刷通知的话系统那边拿到的还是「没有封面」的那一份。
                applyMetadata();
                // 通知已经发出去了，要再 post 一次才会带上新封面。
                publishNotification();
            }
        }, "folia-artwork").start();
    }

    private static Bitmap downloadBitmap(String url) {
        java.io.InputStream stream = null;
        try {
            java.net.HttpURLConnection connection =
                    (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(10000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Mozilla/5.0");
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                connection.disconnect();
                return null;
            }
            stream = connection.getInputStream();
            Bitmap decoded = android.graphics.BitmapFactory.decodeStream(stream);
            connection.disconnect();
            if (decoded == null) {
                return null;
            }
            // 通知栏只需要一张小图，顺手压到 512，避免大图白占内存。
            int edge = Math.max(decoded.getWidth(), decoded.getHeight());
            if (edge > 512) {
                float ratio = 512f / edge;
                Bitmap scaled = android.graphics.Bitmap.createScaledBitmap(decoded,
                        Math.round(decoded.getWidth() * ratio),
                        Math.round(decoded.getHeight() * ratio), true);
                decoded.recycle();
                return scaled;
            }
            return decoded;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to download the cover", error);
            return null;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (java.io.IOException ignored) {
                    // 关闭失败不影响结果。
                }
            }
        }
    }

    private void updatePlaybackState(Intent intent) {
        String state = intent.getStringExtra(EXTRA_STATE);
        boolean playing = "playing".equals(state);
        long positionMs = intent.getLongExtra(EXTRA_POSITION, 0L);
        float speed = intent.getFloatExtra(EXTRA_SPEED, 1.0f);

        int compatState;
        if ("playing".equals(state)) {
            compatState = PlaybackStateCompat.STATE_PLAYING;
        } else if ("paused".equals(state)) {
            compatState = PlaybackStateCompat.STATE_PAUSED;
        } else {
            compatState = PlaybackStateCompat.STATE_STOPPED;
        }

        cachedState = compatState;
        cachedPositionMs = positionMs;
        cachedSpeed = speed;
        cachedPlaying = playing;
        /*
         * Web 层回过话了：那次「乐观播放」的宽限检查到此为止，不用再猜。
         *
         * 但它说「没在播」的时候不能只是撤掉检查 —— onPlay 那一刻已经把锚点切成在播了，
         * 撤掉就没人把锚点收回来，壁纸、叠层、状态栏歌词继续往外推，实际一点声音都没有
         * （用户原话）。壁纸那边的心跳指望不上：它是 JS 的 setInterval，后台里不一定跑。
         * 所以这里就地冻回去，位置用 Web 层报上来的那份（它才知道真实进度），
         * 没带位置才退回按下播放那一刻记下的。
         */
        boolean wasOptimisticPlay = playConfirmPending;
        playConfirmPending = false;
        // Web 层回过话，补发额度也就还回去了：下一次用户真的按下播放才再用。
        playNudges = 0;
        mainHandler.removeCallbacks(playConfirmCheck);
        if (wasOptimisticPlay && !playing) {
            long freezeAt = intent.hasExtra(EXTRA_POSITION) ? positionMs : playConfirmAnchorMs;
            if (freezeAt < 0L) {
                freezeAt = playConfirmAnchorMs;
            }
            top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(freezeAt, false);
            top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                    .shared(this).invalidateOverlay();
        }
        publishSnapshot();
        applyPlaybackState();
    }

    /**
     * 用当前缓存的字段重建 PlaybackState 并写回 MediaSession。
     *
     * 调用点不止「Web 推状态」一个：歌词到了也要重挂一次翻译按钮（见
     * ACTION_REFRESH_METADATA），而 PlaybackState 是不可变对象，
     * 每次重建都得把该保留的东西重新加一遍。
     */
    private void applyPlaybackState() {
        PlaybackStateCompat.Builder builder = new PlaybackStateCompat.Builder()
                .setActions(supportedActions())
                .setState(cachedState, resolvePlaybackPositionMs(), cachedSpeed);
        // ColorOS 锁屏歌词：有翻译 lane 时把 Bridge 的公共「翻译」按钮挂上。
        //
        // CustomAction.Builder 强制要求一个**非零**图标资源 id，传 0 会直接构造失败；
        // 图标长什么样无所谓 —— SystemUI 建好 Action 之后 Bridge 会把它换成自带的
        // ic_translation。所以拿应用图标当占位即可。
        if (ColorOsLyricBridge.hasTranslationFor(cachedSongKey)) {
            builder.addCustomAction(new PlaybackStateCompat.CustomAction.Builder(
                    ColorOsLyricBridge.ACTION_TOGGLE_TRANSLATION,
                    "翻译",
                    translationActionIcon()).build());
        }
        // 「喜欢」：给系统媒体控制器用的那一颗（锁屏、Android Auto、Wear OS 等）。
        // 通知栏那颗心是 NotificationCompat.Action，两条路都发同一条 "like" 命令。
        // 只在真的能用时挂上：挂了却点不出结果，比不给这个按钮更让人困惑。
        if (cachedCanLike) {
            builder.addCustomAction(new PlaybackStateCompat.CustomAction.Builder(
                    ACTION_TOGGLE_LIKE,
                    cachedLiked ? "取消喜欢" : "喜欢",
                    cachedLiked ? R.drawable.folia_heart_filled : R.drawable.folia_heart).build());
        }
        if (mediaSession != null) {
            mediaSession.setPlaybackState(builder.build());
        }
    }

    private int translationActionIcon() {
        int icon = getApplicationInfo().icon;
        return icon != 0 ? icon : android.R.drawable.ic_menu_manage;
    }

    /**
     * 当前媒体信息的一份**快照**，供音乐锁屏底部的面板读取。
     *
     * 为什么不做成回调 / 广播：锁屏页活在另一个组件里，而且随时可能被系统回收重建
     * （转屏、内存紧张）。推的模式要维护订阅表，还得处理"推送时锁屏页还没起来"；
     * 拉的模式只要一份 volatile 快照，页面起来时读一次、之后每秒再读一次即可 ——
     * 反正这些字段本来就是给通知用的，服务里已经有一份现成的缓存。
     */
    public static final class MediaSnapshot {
        public final String title;
        public final String artist;
        public final String album;
        /** 已经解码好的封面（通知栏用的就是这一张）。null = 还没拿到。 */
        public final Bitmap artwork;
        public final long durationMs;
        public final long positionMs;
        /**
         * `positionMs` 是**哪一刻**的值（SystemClock.elapsedRealtime()）。
         *
         * 带上它，读快照的一方才能自己往前外推：这一份是推送时写的，而推送会随着
         * WebView 被 Chromium 节流而长时间不来（锁屏 / 息屏那一会儿能拖到几十秒）。
         * 没有这个时刻，读到的就永远是"几十秒前的位置"，进度条看着就是不动。
         * 系统通知栏那条不缺这一步 —— PlaybackState 自带 updateTime，由 SystemUI 外推。
         */
        public final long positionTakenAtElapsedMs;
        public final boolean playing;
        /** 当前这首歌是不是「已喜欢」。 */
        public final boolean liked;
        /** 「喜欢」这个动作现在能不能用（平台不支持时为 false）。 */
        public final boolean canLike;

        MediaSnapshot(String title, String artist, String album, Bitmap artwork,
                long durationMs, long positionMs, long positionTakenAtElapsedMs,
                boolean playing, boolean liked, boolean canLike) {
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
            this.durationMs = durationMs;
            this.positionMs = positionMs;
            this.positionTakenAtElapsedMs = positionTakenAtElapsedMs;
            this.playing = playing;
            this.liked = liked;
            this.canLike = canLike;
        }
    }

    private static volatile MediaSnapshot lastSnapshot = null;

    /** 最近一次的媒体信息。服务没起来过就是 null（那时锁屏页也不会显示）。 */
    public static MediaSnapshot snapshot() {
        return lastSnapshot;
    }

    /**
     * 进度条**此刻**该站的位置：快照里那一份，加上从记下它那刻起到现在流过的时间。
     *
     * 直接用快照里的 positionMs 是不够的 —— 那一推从 Web 层来，而锁屏 / 息屏那会儿
     * WebView 的定时器被 Chromium 节流（1 秒变 1 分钟），快照就停在几十秒前的数上，
     * 表现就是「进度条不动」「一直是 00」（原生播放器那条路上的注释也记着这个症状）。
     *
     * 系统通知栏那条没有这个问题：PlaybackState 自带 updateTime 与速度，由 SystemUI
     * 外推。这里补上同一件事，锁屏那条才跟通知栏那条是同一条。
     *
     * 原生在放时直接问播放器：它既是真值，也不吃 Web 那份节流（见
     * resolvePlaybackPositionMs）。暂停时不外推 —— 手指停在那就该停在那就。
     */
    public static long livePositionMs() {
        MediaSnapshot info = lastSnapshot;
        if (info == null) {
            return 0L;
        }
        if (top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()) {
            long nativePosition =
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.currentPositionMs();
            if (nativePosition >= 0L) {
                return nativePosition;
            }
        }
        long base = Math.max(0L, info.positionMs);
        if (!info.playing) {
            return base;
        }
        long elapsed = android.os.SystemClock.elapsedRealtime() - info.positionTakenAtElapsedMs;
        if (elapsed <= 0L) {
            return base;
        }
        long advanced = base + elapsed;
        // 外推不能溢出时长：缓冲 / 卡顿那一会儿它会跑在真实位置前面，夹住即可，
        // 下一推来了自然会被拉回真值。
        return info.durationMs > 0L ? Math.min(advanced, info.durationMs) : advanced;
    }

    private void publishSnapshot() {
        lastSnapshot = new MediaSnapshot(cachedTitle, cachedArtist, cachedAlbum,
                cachedArtwork, cachedDurationMs, resolvePlaybackPositionMs(),
                android.os.SystemClock.elapsedRealtime(),
                cachedPlaying, cachedLiked, cachedCanLike);
    }

    /**
     * 通知栏 / 锁屏那条进度条该显示的位置。
     *
     * 原生在放的时候直接问播放器：它的位置就是真值。Web 报上来的那一份要过 Chromium 的
     * 定时器节流 —— 挂着不动久了，那一推可能几十秒才来一次，通知栏就停着、或者一直是 00。
     * 其余情况照旧用 Web 报的位置：`<audio>` 播到哪只有它知道。
     */
    private long resolvePlaybackPositionMs() {
        if (top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()) {
            long nativePosition = top.izuna.foliamajor.player.FoliaNativePlayerPlugin.currentPositionMs();
            if (nativePosition >= 0L) {
                return nativePosition;
            }
        }
        return cachedPositionMs;
    }

    /**
     * 往 Web 层发一条播放控制指令（上一首 / 下一首）。
     *
     * 锁屏面板走的是**通知栏同一条路**：指令交给 FoliaCommandReceiver，由它派发给
     * Capacitor 插件、再交给 Web 层。原生不自己另起一套播放器状态机 ——
     * 真正知道"下一首是什么"的只有 Web 层（队列、随机、自动混播都在那边）。
     */
    static void sendPlaybackCommand(Context context, String command) {
        // 必须写死组件名：Android 8+ 的隐式广播不会投递给清单注册的接收器。
        Intent intent = new Intent(context, FoliaCommandReceiver.class);
        intent.setAction(ACTION_WEB_COMMAND);
        intent.putExtra(EXTRA_COMMAND, command);
        context.sendBroadcast(intent);
    }

    /** 带位置的指令（锁屏面板拖进度条用）。 */
    static void sendPlaybackCommand(Context context, String command, long positionMs) {
        Intent intent = new Intent(context, FoliaCommandReceiver.class);
        intent.setAction(ACTION_WEB_COMMAND);
        intent.putExtra(EXTRA_COMMAND, command);
        intent.putExtra(EXTRA_COMMAND_POSITION, positionMs);
        context.sendBroadcast(intent);
    }

    private Bitmap decodeArtwork(String base64) {
        if (base64 == null || base64.isEmpty()) {
            return null;
        }
        try {
            // data URL 前缀（data:image/jpeg;base64,）要去掉，否则解码会失败。
            int comma = base64.indexOf(',');
            String payload = comma >= 0 ? base64.substring(comma + 1) : base64;
            byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Throwable error) {
            // 封面解析失败不该影响播放与通知，退回默认图标即可。
            Log.w(TAG, "Failed to decode artwork", error);
            return null;
        }
    }

    /**
     * 平台 key → 角标 drawable。
     *
     * 图标文件在 res/drawable-nodpi/ 下（ic_provider_*.png，与 src/assets/providers/ 的同一套）。
     * 没登记的平台（含空值）一律回落 Folia 本尊 —— 通知栏角标永远画得出东西，只是不一定认得。
     */
    private static int providerIconRes(String badge) {
        if (badge == null) return R.mipmap.ic_launcher;
        switch (badge) {
            case "netease": return R.drawable.ic_provider_netease;
            case "qq": return R.drawable.ic_provider_qq;
            case "kugou": return R.drawable.ic_provider_kugou;
            case "bodian": return R.drawable.ic_provider_bodian;
            // 飞牛（自建服务）：图标是**白色剪影 + 透明底**，不是那张彩色图 ——
            // 通知栏的 smallIcon 从 Android 5.0 起只认 alpha，彩色图会被整体染成一个
            // 没有细节的色块。剪影由那张官方图标去掉红底得来（alpha 取三通道最小值）。
            case "feiniu": return R.drawable.ic_provider_feiniu;
            // 汽水音乐：Electron-only，但通知栏角标资源仍保留一份白色剪影，保持全量接入。
            case "qishui": return R.drawable.ic_provider_qishui;
            default: return R.mipmap.ic_launcher;
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "播放控制",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("在通知栏显示当前播放的歌曲与播放控制");
        // 播放控制不该发出提示音或震动。
        channel.setSound(null, null);
        channel.enableVibration(false);
        notificationManager.createNotificationChannel(channel);
    }

    /**
     * 用当前缓存的字段重建整条通知。
     *
     * metadata 与 playbackState 是两次独立的调用，所以通知内容必须从缓存整体重建，
     * 否则后到的那次会把先到的字段抹成空。
     */
    private Notification buildForegroundNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                // 封面角标：媒体通知会把 small icon 画在封面右下角，原本是 ic_media_play 那个 ▶，
                // 现在换成「这首歌来自哪个平台」的应用图标（本地等自家人用 Folia 本尊）。
                // 没收到过角标信息时（0）回落 Folia 图标，不再显示播放三角。
                .setSmallIcon(cachedBadgeRes != 0 ? cachedBadgeRes : R.mipmap.ic_launcher)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                // 通知属于前台服务，用户无法手动划掉它（划掉就等于杀掉播放）。
                .setOngoing(true);

        // 通知栏的按钮：上一首 / 播放暂停 / 下一首 /（可用时）喜欢。
        // 必须真的 addAction —— MediaStyle 的紧凑视图只是「从第 0/1/2 个 action 里挑出来显示」，
        // 不 addAction 就写 setShowActionsInCompactView(0,1,2) 是越界引用，等于白写。
        boolean playing = cachedState == PlaybackStateCompat.STATE_PLAYING;
        builder.addAction(buildAction(android.R.drawable.ic_media_previous, "上一首", "previous"));
        builder.addAction(playing
                ? buildAction(android.R.drawable.ic_media_pause, "暂停", "pause")
                : buildAction(android.R.drawable.ic_media_play, "播放", "play"));
        builder.addAction(buildAction(android.R.drawable.ic_media_next, "下一首", "next"));
        // 「喜欢」放第四位：紧凑视图（收起那条通知）只显示前三个，上一首 / 播停 / 下一首
        // 是任何时候都得在的，喜欢只能退到展开态。它同时在 MediaSession 上挂了
        // CustomAction（见 applyPlaybackState），锁屏与车机那类控制器照样看得到。
        if (cachedCanLike) {
            builder.addAction(buildAction(
                    cachedLiked ? R.drawable.folia_heart_filled : R.drawable.folia_heart,
                    cachedLiked ? "取消喜欢" : "喜欢",
                    "like"));
        }

        MediaSessionCompat.Token token = mediaSession == null ? null : mediaSession.getSessionToken();
        if (token != null) {
            builder.setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(token)
                    .setShowActionsInCompactView(0, 1, 2));
        }

        if (!cachedTitle.isEmpty()) {
            builder.setContentTitle(cachedTitle);
        } else {
            builder.setContentTitle("Folia");
        }
        if (!cachedArtist.isEmpty()) {
            builder.setContentText(cachedArtist);
        }
        if (cachedArtwork != null) {
            builder.setLargeIcon(cachedArtwork);
        }

        // 点击通知栏本体回到应用。getLaunchIntentForPackage 返回的是 Intent，
        // 通知的 setContentIntent 要的是 PendingIntent；该 Intent 自带
        // FLAG_ACTIVITY_NEW_TASK | RESET_TASK_IF_NEEDED，点通知不会在任务栈里叠一份新的 Activity。
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent != null) {
            PendingIntent contentIntent = PendingIntent.getActivity(
                    this, 0, launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.setContentIntent(contentIntent);
        }

        return builder.build();
    }

    /**
     * 通知栏按钮。
     *
     * 点下去直接广播给 FoliaCommandReceiver，由它交给插件派发给 Web 层。
     * 用 command 的 hashCode 作 requestCode，三个按钮才不会互相复用同一个 PendingIntent。
     */
    private NotificationCompat.Action buildAction(int icon, CharSequence title, String command) {
        Intent intent = new Intent(this, FoliaCommandReceiver.class);
        intent.setAction(ACTION_WEB_COMMAND);
        intent.putExtra(EXTRA_COMMAND, command);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent =
                PendingIntent.getBroadcast(this, command.hashCode(), intent, flags);
        return new NotificationCompat.Action(icon, title, pendingIntent);
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        foregrounded = false;
        // 通知已经被撤下来了：再前台化时按当前缓存重建，别把撤掉的那条贴回去。
        cachedNotification = null;
    }

    // ---- Web 层（useCapacitorPlaybackBridge）通过这些常量与服务交互 ----

    static final String ACTION_UPDATE_METADATA = "top.izuna.foliamajor.action.UPDATE_METADATA";
    static final String ACTION_UPDATE_STATE = "top.izuna.foliamajor.action.UPDATE_STATE";
    /**
     * 按缓存重建一次 metadata + PlaybackState，不改动任何缓存字段。
     *
     * 给 ColorOS 原生歌词用：歌词到的时刻与 metadata 到的时刻是两个独立事件，
     * 谁先谁后都可能，这条动作让「后到的那个」能把两者合起来重新发出去。
     * 别的包要用，所以是 public。
     */
    public static final String ACTION_REFRESH_METADATA = "top.izuna.foliamajor.action.REFRESH_METADATA";
    static final String ACTION_STOP_FOREGROUND = "top.izuna.foliamajor.action.STOP_FOREGROUND";
    static final String ACTION_WEB_COMMAND = "top.izuna.foliamajor.action.WEB_COMMAND";
    static final String EXTRA_COMMAND = "command";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ARTIST = "artist";
    static final String EXTRA_ALBAND = "album";
    static final String EXTRA_ARTWORK = "artwork";
    static final String EXTRA_ARTWORK_URL = "artworkUrl";
    static final String EXTRA_DURATION = "duration";
    /** 封面角标（通知 small icon）用哪颗图标：当前播放来源的平台 key。 */
    static final String EXTRA_PROVIDER_BADGE = "providerBadge";
    /** 当前这首歌的身份：与上一次不同就是换歌了，换歌时先丢掉上一首的封面。 */
    static final String EXTRA_SONG_KEY = "songKey";
    /** 当前这首歌是不是「已喜欢」（通知栏那颗心画实心还是空心）。 */
    static final String EXTRA_LIKED = "liked";
    /** 「喜欢」这个动作当前能不能用；false 时通知栏不画那颗心。 */
    static final String EXTRA_CAN_LIKE = "canLike";
    /**
     * MediaSession 的自定义动作名：「喜欢 / 取消喜欢」。
     *
     * 走 CustomAction 而不是 PlaybackState 的标准动作，是因为 MediaSessionCompat
     * 没有「喜欢」这一档 —— 系统媒体控制器（锁屏、Android Auto、蓝牙设备）看见的是
     * 我们自己声明的这个字符串。通知栏那颗心是**另外**加的 NotificationCompat.Action，
     * 两条路都通向同一个 sendCommand("like")。
     */
    static final String ACTION_TOGGLE_LIKE = "top.izuna.foliamajor.action.TOGGLE_LIKE";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_POSITION = "position";
    /** 拖动通知栏进度条时带回的目标位置（毫秒）。 */
    static final String EXTRA_COMMAND_POSITION = "commandPosition";
    static final String EXTRA_SPEED = "speed";
}
