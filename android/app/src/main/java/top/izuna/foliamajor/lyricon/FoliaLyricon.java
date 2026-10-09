package top.izuna.foliamajor.lyricon;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

import io.github.proify.lyricon.lyric.model.RichLyricLine;
import io.github.proify.lyricon.lyric.model.Song;
import io.github.proify.lyricon.provider.LyriconFactory;
import io.github.proify.lyricon.provider.LyriconProvider;
import io.github.proify.lyricon.provider.RemotePlayer;

/**
 * 状态栏歌词（Lyricon）的原生侧。
 *
 * Lyricon 是一个中心服务：各个播放器作为「Provider」把当前歌曲、歌词与播放进度推给它，
 * 由它统一渲染到状态栏。这里做的就是把 Folia 已经在播的东西转译过去。
 *
 * 两条纪律：
 * 1. **SDK 是 Kotlin 写的，Kotlin 的默认参数对 Java 不可见**，所以 `createProvider`
 *    的八个参数必须一个不少地显式传（默认值见 LyriconFactory 的 `createProvider$default`）。
 * 2. **任何一次调用失败都不能带崩应用。** 用户可能压根没装 Lyricon，也可能装的是不兼容的
 *    版本；那时这里只是安静地不可用，UI 上如实显示「未连接」即可。
 */
public final class FoliaLyricon {

    private static final String TAG = "FoliaLyricon";
    private static final String PREFS = "folia_lyricon";
    private static final String KEY_ENABLED = "enabled";
    /** Lyricon 中心服务的包名，SDK 自己的默认值。 */
    private static final String CENTRAL_PACKAGE = "com.android.systemui";

    /** 位置推进容差（毫秒）：比这更小的前进不值得单独过桥一次。 */
    private static final long POSITION_EPSILON_MS = 200L;
    /**
     * 时间倒退的容差（毫秒）。真跳转一次会退很远，采样抖动只退一点点；
     * 小步后退一律丢弃，否则中心服务会在两个字之间来回抽搐。
     */
    private static final long BACKWARD_JITTER_MS = 1200L;
    /**
     * 判定「这是一次跳转」的跨度（毫秒）。
     *
     * 心跳 500ms 一次，正常播放时相邻两帧的位置差就是 500ms 上下；差出 2 秒以上
     * 就只可能是拖动进度条、切歌恢复进度这类真跳转。
     */
    private static final long SEEK_JUMP_MS = 2000L;
    /**
     * 中心服务读取播放位置的间隔（毫秒）。
     *
     * `setPosition` 只是往一块 SharedMemory 里写一个 long（没有 IPC、也不会回弹），
     * 中心服务按自己的节奏去读。两边节奏对不上时，它按速度外推出来的位置和我们写进去的
     * 位置会在每个周期互相拉扯 —— 这就是「进度抽搐」。所以这里显式对齐到心跳的 500ms。
     */
    private static final int POSITION_UPDATE_INTERVAL_MS = 500;

    private static volatile LyriconProvider provider;
    private static volatile RemotePlayer player;
    private static volatile boolean registered;
    /** 建过一次失败就不再反复重试：中心服务不在就是不在，重试只会白耗一次绑定。 */
    private static volatile boolean unavailable;

    /**
     * 上一次真正推给中心服务的播放状态与位置。
     *
     * 心跳每 500ms 一次，但**播放状态绝大多数心跳里都没变**。早先的做法是每次心跳
     * 都跟着 setPosition 一起把 setPlaybackState 也推一遍，中心服务每次收到都要重算
     * 一遍显示状态 —— 表现是偶发卡顿，以及进度条/高亮位置突然抽搐。这里只在状态真的
     * 翻转、或位置真的往前走了的时候才推。
     */
    private static volatile Boolean lastPlaying = null;
    private static volatile long lastPositionMs = -1L;

    /**
     * 最近一次推给中心服务的歌。
     *
     * 重新注册之后要能把整首再发一遍：中心服务的进程重启（SystemUI 重建、用户强停）
     * 会把我们这条 Provider 记录丢掉，那时候只补位置是补不回来的 ——
     * 状态栏上没有歌词，补什么位置都没意义。而 JS 那边恰好**不知道**这件事
     * （没有回读通道），所以这份缓存必须由原生自己留着。
     */
    private static volatile Song lastSong = null;
    /** 上面那首歌对应的签名：重发之后要把它**补回去**，否则心跳会每 5 秒重发一次整首。 */
    private static volatile String lastSongSignature = null;

    /**
     * 位置推进的锚点：`SystemClock.elapsedRealtime()` 走到 `anchorElapsedMs` 时，
     * 播放位置是 `anchorPositionMs`，速度恒为 1x（暂停时不再前进）。
     *
     * **这就是为什么保活必须放在原生：** Web 侧的心跳是 JS 定时器，应用一退到后台
     * 就被系统挂起 —— 而状态栏歌词**恰恰**是应用不在前台时才有人看的东西。
     * 于是症状就变成「有时候不动了，转屏也没用，只有暂停再播放能救回来」：
     * 那条路径本来就是 JS 唯一的活路，而它在后台早就不跑了。
     *
     * 锚点模型让原生成了唯一的时间源：应用每次告诉我们位置，就顺手更新一次锚点，
     * 之后由**原生按自己的墙钟往前推**，每隔 HEARTBEAT_INTERVAL_MS 写一次。
     * JS 冻住也没关系，歌词照样往下走。
     */
    private static volatile long anchorPositionMs = 0L;
    private static volatile long anchorElapsedMs = 0L;
    private static volatile boolean anchorPlaying = false;
    private static volatile long anchorDurationMs = 0L;

    private static final long HEARTBEAT_INTERVAL_MS = 5000L;
    private static volatile Handler mainHandler = null;
    private static volatile Context heartbeatContext = null;
    private static volatile boolean heartbeatScheduled = false;

    private static Handler handler() {
        if (mainHandler == null) {
            mainHandler = new Handler(Looper.getMainLooper());
        }
        return mainHandler;
    }

    private FoliaLyricon() {}

    public static boolean isEnabled(Context context) {
        if (context == null) return false;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false);
    }

    /** 中心服务在不在。只有真正注册成功之后才敢说「在」。 */
    public static boolean isConnected() {
        return registered && player != null && player.isActive();
    }

    /**
     * 开关。关掉时主动 unregister 并 destroy，把远端连接放掉 ——
     * 只是不推数据的话，中心服务那边仍会一直显示上一首的歌词。
     */
    public static synchronized boolean setEnabled(Context context, boolean enabled) {
        if (context == null) return false;
        Context appContext = context.getApplicationContext();
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply();
        if (!enabled) {
            teardown();
            return true;
        }
        return ensureRegistered(appContext);
    }

    /** 上一次推过去的歌的签名。用来挡掉重复的 setSong（见 publish）。 */
    private static volatile String publishedSignature = null;

    /**
     * 保活心跳（原生侧）。
     *
     * 见 `anchorPositionMs` 的说明：段内的推进不能指望 JS 的定时器。
     * 这里每 5 秒按锚点算一次当前位置写进去 —— 走得准的话，写进去的值和中心服务
     * 自己外推出来的几乎一致，完全看不出来；万一它哪天不自己走了，最多 5 秒就接上。
     */
    private static final Runnable heartbeatTask = new Runnable() {
        @Override
        public void run() {
            heartbeatScheduled = false;
            Context context = heartbeatContext;
            if (context == null || !isEnabled(context)) {
                return;
            }
            synchronized (FoliaLyricon.class) {
                try {
                    tickLocked(context);
                } catch (Throwable error) {
                    Log.w(TAG, "Lyricon heartbeat failed", error);
                }
            }
            scheduleHeartbeat();
        }
    };

    private static void scheduleHeartbeat() {
        if (heartbeatScheduled) {
            return;
        }
        heartbeatScheduled = true;
        handler().postDelayed(heartbeatTask, HEARTBEAT_INTERVAL_MS);
    }

    private static void stopHeartbeat() {
        heartbeatScheduled = false;
        if (mainHandler != null) {
            mainHandler.removeCallbacks(heartbeatTask);
        }
    }

    /** 心跳这一轮真正做的事。调用方已持锁。 */
    private static void tickLocked(Context context) {
        /*
         * 先确认连接还活着。
         *
         * 「不动了」的另一种可能：中心服务进程被重建（SystemUI 重启、内存回收），
         * 我们这条注册记录随之失效，而 `registered` 这个布尔量还停在 true ——
         * 之后无论写什么位置都进不去。`player.isActive()` 是唯一的现问手段。
         * 发现失效就整套重来：重新注册成功后把缓存的那首歌再发一遍，然后照常补位置。
         */
        if (player != null && registered && !player.isActive()) {
            Log.w(TAG, "Lyricon session went inactive; re-registering");
            registered = false;
            player = null;
            provider = null;
            publishedSignature = null;
            lastPlaying = null;
            lastPositionMs = -1L;
        }
        if (!ensureRegistered(context)) {
            return;
        }
        if (lastSong != null && publishedSignature == null) {
            /*
             * 重连之后整首再发一次（含随之而来的位置补全），顺序纪律见 publish。
             *
             * 发完必须把签名补回去：不补的话 publishedSignature 一直是 null，
             * 心跳会每隔 5 秒重发一次整首 —— 而 setSong 会重置中心服务的显示状态，
             * 那正好是「状态栏每隔几秒闪一下」的形状，比不动还难看。
             */
            if (publishSongLocked(lastSong)) {
                publishedSignature = lastSongSignature;
            }
        }
        if (!anchorPlaying) {
            return;
        }
        long elapsed = SystemClock.elapsedRealtime() - anchorElapsedMs;
        long positionMs = anchorPositionMs + Math.max(0L, elapsed);
        if (anchorDurationMs > 0L) {
            positionMs = Math.min(positionMs, anchorDurationMs);
        }
        /*
         * allowSeek = false：心跳是正常播放的**延续**，不是跳转。
         *
         * 走 seekTo 那条路的话，中心服务每 5 秒被告知一次「这是一次跳转」，
         * 它会丢掉现有的显示状态去追一个新位置 —— 那正好就是我们花了几轮才清掉的
         * 「抽搐」，只不过从每段一次变成每 5 秒一次。
         */
        applyLocked(positionMs, true, false, false);
    }

    /**
     * 应用最近一次告诉我们的位置 / 播放状态。
     *
     * 和下面去重用那两个字段**不是一回事**：那两个是"上次真正过桥了什么"，
     * 会被 `publish` 清零；这两个是"应用现在在哪"，用来在 setSong 之后把位置补回去
     * （见 publish 里的说明）。
     */
    private static volatile long knownPositionMs = 0L;
    private static volatile boolean knownPlaying = false;

    /**
     * 播放状态带上**速度**和"这个位置是哪一时刻的"。
     *
     * 只调 `setPlaybackState(boolean)` 的话，中心服务只知道"在播 / 没在播"，
     * 位置只能靠我们一遍遍写进共享内存 —— 写得频繁，它读出来的和我们写进去的
     * 反复拉扯（抽搐）；写得稀疏，它就停在最后一次写的值上不动。
     *
     * `PlaybackState` 里带 `playbackSpeed` 与 `lastPositionUpdateTime`，
     * 中心服务可以自己按 `position + (now - updateTime) * speed` 往前推 ——
     * 于是段内我们一句话都不用说，也不用按节拍灌位置。
     */
    private static PlaybackState buildPlaybackState(long positionMs, boolean playing) {
        PlaybackState.Builder builder = new PlaybackState.Builder();
        builder.setState(
                playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                positionMs,
                // 暂停时速度必须是 0：留着 1.0 的话中心服务会一路推算到歌曲外面去。
                playing ? 1.0f : 0.0f,
                SystemClock.elapsedRealtime());
        return builder.build();
    }

    /**
     * 判断「这首歌跟上次推的是不是同一首」。
     *
     * 只看能改变画面内容的字段：曲目标识、时长、行数、首尾行文本与有没有翻译。
     * 不看播放位置 —— 那是 setPosition 的事。
     */
    private static String signatureOf(String id, String title, String artist, long durationMs,
                                     List<RichLyricLine> lines) {
        StringBuilder builder = new StringBuilder();
        builder.append(id).append('␟').append(title).append('␟').append(artist)
                .append('␟').append(durationMs).append('␟');
        if (lines != null) {
            builder.append(lines.size());
            for (RichLyricLine line : lines) {
                builder.append('␞').append(line.getText())
                        .append('␞').append(line.getBegin())
                        .append('␞').append(line.getTranslation() == null ? "" : line.getTranslation());
            }
        }
        return builder.toString();
    }

    /**
     * 换歌：整首歌连同歌词一起推过去。
     *
     * **重复推同一首会被挡掉。** 歌词是异步到的（翻译尤其晚），数组每次都是新对象，
     * 若不加这道签名，同一个 effect 会反复触发 setSong —— 中心服务每次收到 setSong
     * 都会重置显示状态，用户看到的就是「双行用着用着变回单行」。
     */
    public static synchronized boolean publish(Context context, String id, String title,
                                              String artist, long durationMs,
                                              List<RichLyricLine> lines) {
        if (context == null) return false;
        Context appContext = context.getApplicationContext();
        if (!isEnabled(appContext)) return false;
        String signature = signatureOf(id, title, artist, durationMs, lines);
        /*
         * **同一首被去重时也必须把位置补回去。**
         *
         * publish 在 Web 侧还兼着「重同步」的角色：回前台、转屏走的都是
         * 「整首推一次 + 紧接着补位置」这一串。内容没变 → 签名相同 → 直接返回，
         * 于是中心服务那边既没有 setSong 也没有位置写入 —— 「切换屏幕方向也没有用」
         * 就是从这儿来的：去重把它当成无事发生，而调用方恰恰是在求一次全量重同步。
         *
         * 补一次位置是最便宜的动作（共享内存里一个 long，没有 IPC），
         * 对外又正好是一次「全量重同步」该有的样子。
         */
        if (signature.equals(publishedSignature)) {
            applyLocked(positionNowLocked(), anchorPlaying, true, false);
            return true;
        }
        if (!ensureRegistered(appContext)) return false;
        try {
            Song song = new Song(
                    id == null ? "" : id,
                    title == null ? "" : title,
                    artist == null ? "" : artist,
                    durationMs > 0L ? durationMs : 0L,
                    null,
                    lines == null ? new ArrayList<RichLyricLine>() : lines);
            lastSong = song;
            lastSongSignature = signature;
            anchorDurationMs = durationMs > 0L ? durationMs : 0L;
            if (!publishSongLocked(song)) return false;
            publishedSignature = signature;
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to publish the current song to Lyricon", error);
            return false;
        }
    }

    /**
     * 真正过桥发一首歌，并**紧接着把位置补回去**。
     *
     * 调用方必须已经 `ensureRegistered` 且持锁。
     */
    private static boolean publishSongLocked(Song song) {
        try {
            if (player == null) return false;
            if (!player.setSong(song)) return false;
            // 顺序按 SDK 文档：先 setSong，再位置与播放状态，显示开关放最后。
            player.setDisplayTranslation(true);
            /*
             * **setSong 之后必须立刻把位置补回去，而且是原生自己补。**
             *
             * setSong 会重置中心服务的显示状态（位置也一起清掉）。
             * 以前靠 JS 在 publish 之后紧接着调一次 setPosition 来补 —— 但那是两个
             * 独立的桥调用，谁先到原生**没有保证**：位置先到的话，紧接着的 setSong
             * 就把它冲掉了，之后再没有任何人推位置。表现正是
             * 「切了下一首状态栏完全不动」。而且回前台 / 转屏走的是同一条路，
             * 所以它们也一起失效。
             *
             * 放在原生这一侧补，顺序就是确定的：setSong 成功 → 立刻 setPosition。
             */
            lastPlaying = null;
            lastPositionMs = -1L;
            applyLocked(positionNowLocked(), anchorPlaying, true, false);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to publish the current song to Lyricon", error);
            return false;
        }
    }

    /** 按锚点算出现在的播放位置（暂停时停在锚点上不前进）。 */
    private static long positionNowLocked() {
        if (!anchorPlaying) {
            return knownPositionMs;
        }
        long elapsed = SystemClock.elapsedRealtime() - anchorElapsedMs;
        long positionMs = anchorPositionMs + Math.max(0L, elapsed);
        if (anchorDurationMs > 0L) {
            positionMs = Math.min(positionMs, anchorDurationMs);
        }
        return positionMs;
    }

    /**
     * 播放进度与播放/暂停。心跳每次都走这里，所以失败也只记一条日志。
     *
     * **播放状态只在翻转时推。** 每 500ms 重推一次同一个 playing 值，中心服务就要重算
     * 一次显示状态，用户看到的是偶发卡顿与进度抽搐。
     *
     * **位置只在真的动了时推。** 暂停时位置根本不变，那样的心跳一次都不必过桥。
     */
    public static synchronized boolean setPosition(Context context, long positionMs, boolean playing,
                                                   boolean continuous) {
        if (context == null) return false;
        Context appContext = context.getApplicationContext();
        if (!isEnabled(appContext)) return false;
        if (!ensureRegistered(appContext)) return false;
        // 记下"应用现在在哪"，换歌时要用它把位置补回去（见 publish）。
        knownPositionMs = positionMs;
        knownPlaying = playing;
        /*
         * 每次 application 告诉我们位置，就顺手把锚点刷新一次：
         * 原生的保活心跳靠它往前推（见 heartbeatTask）。
         */
        anchorPositionMs = positionMs;
        anchorElapsedMs = SystemClock.elapsedRealtime();
        anchorPlaying = playing;
        heartbeatContext = appContext;
        scheduleHeartbeat();
        return applyLocked(positionMs, playing, true, !continuous);
    }

    /**
     * 真正过桥的那一段。调用方必须已经 `ensureRegistered` 且持有锁。
     *
     * @param force     无条件写。那两个 epsilon 去重会让一次「重同步」变成空操作
     *                  （见 publish 的去重分支）—— 明确要求同步时必须绕过它们。
     * @param allowSeek 位置跨度够大时是否明说「这是一次跳转」。心跳必须给 false，
     *                  否则每 5 秒就被当成一次 seek。
     */
    private static boolean applyLocked(long positionMs, boolean playing, boolean force, boolean allowSeek) {
        if (player == null) return false;

        boolean stateChanged = lastPlaying == null || lastPlaying.booleanValue() != playing;
        boolean moved;
        if (force) {
            moved = true;
        } else if (lastPositionMs < 0L) {
            moved = true;
        } else if (positionMs < lastPositionMs) {
            // 时间倒退只有两种可能：真跳转，或采样抖动。小步后退按抖动处理，直接丢弃。
            moved = lastPositionMs - positionMs >= BACKWARD_JITTER_MS;
        } else {
            moved = positionMs - lastPositionMs >= POSITION_EPSILON_MS;
        }

        if (!stateChanged && !moved) {
            return true;
        }

        try {
            /*
             * 顺序不能乱：**状态在前，位置在后。**
             *
             * 试过把位置写在前面、播放状态放后面，结果整条链路完全失效 ——
             * 中心服务收到 setPlaybackState 时会重置自己的显示状态（连带位置），
             * 刚写进去的那一下就被冲掉了。所以位置必须是这一串里**最后**一个动作。
             */
            if (stateChanged) {
                player.setPlaybackState(playing);
                lastPlaying = Boolean.valueOf(playing);
            }
            /*
             * 带速度的 PlaybackState：让中心服务自己往前走的那一份。
             *
             * 单独包一层 try —— 并不是每个版本的中心服务都认这个重载，
             * 万一不支持/直接抛异常，不能把下面正常的 setPosition 一起拖下水。
             *
             * 位置必须在它**之后**再写（见下面）：setPlaybackState 会重置显示状态。
             */
            try {
                player.setPlaybackState(buildPlaybackState(positionMs, playing));
            } catch (Throwable ignored) {
                // 不认就退回"只认喂进去的位置"的模式，其余照旧。
            }
            if (moved) {
                long jump = lastPositionMs < 0L ? 0L : Math.abs(positionMs - lastPositionMs);
                if (allowSeek && jump >= SEEK_JUMP_MS) {
                    // 明说「这是一次跳转」。只改共享内存里的位置的话，中心服务会以为
                    // 播放位置自己跳了一截，于是按速度去追 —— 追的那一段就是抽搐。
                    player.seekTo(positionMs);
                }
                player.setPosition(positionMs);
                lastPositionMs = positionMs;
            }
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to sync the playback position to Lyricon", error);
            return false;
        }
    }

    /** 停止播放 / 清空：让状态栏把歌词收起来，而不是停在没有歌词的那一行上。 */
    public static synchronized void clear(Context context) {
        if (context == null) return;
        Context appContext = context.getApplicationContext();
        // 都清空了，没什么可保活的：心跳下一次 setPosition 会自己再起来。
        stopHeartbeat();
        anchorPlaying = false;
        lastSong = null;
        lastSongSignature = null;
        if (!isEnabled(appContext)) return;
        if (!ensureRegistered(appContext)) return;
        try {
            player.setPlaybackState(false);
            player.setSong(null);
            // 清空之后同一首歌要能重新推上去：签名不清掉的话，publish 会拿它跟
            // 上一次比对后直接返回，歌词就再也不回来了。
            publishedSignature = null;
            lastPlaying = null;
            lastPositionMs = -1L;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to clear the Lyricon state", error);
        }
    }

    private static boolean ensureRegistered(Context context) {
        if (registered && player != null) return true;
        if (unavailable) return false;
        try {
            if (provider == null) {
                String packageName = context.getPackageName();
                provider = LyriconFactory.INSTANCE.createProvider(
                        context,
                        packageName,
                        packageName,
                        null,
                        null,
                        processName(context),
                        null,
                        CENTRAL_PACKAGE);
            }
            if (provider == null) {
                // API 27 以下 SDK 返回空实现；那不是故障，只是不可用。
                unavailable = true;
                Log.w(TAG, "Lyricon provider is unavailable on this device");
                return false;
            }
            player = provider.getPlayer();
            registered = provider.register();
            if (!registered) {
                Log.w(TAG, "Lyricon refused the registration; is the central service installed?");
                return false;
            }
            try {
                // 把中心服务的读取节奏对齐到我们的推送节奏，见 POSITION_UPDATE_INTERVAL_MS。
                player.setPositionUpdateInterval(POSITION_UPDATE_INTERVAL_MS);
            } catch (Throwable error) {
                Log.w(TAG, "Failed to align the position update interval", error);
            }
            return true;
        } catch (Throwable error) {
            unavailable = true;
            Log.w(TAG, "Failed to register as a Lyricon provider", error);
            return false;
        }
    }

    private static void teardown() {
        stopHeartbeat();
        anchorPlaying = false;
        lastSong = null;
        lastSongSignature = null;
        try {
            if (registered && provider != null) {
                provider.unregister();
            }
        } catch (Throwable error) {
            Log.w(TAG, "Failed to unregister from Lyricon", error);
        }
        try {
            if (provider != null) {
                provider.destroy();
            }
        } catch (Throwable error) {
            Log.w(TAG, "Failed to destroy the Lyricon provider", error);
        }
        registered = false;
        player = null;
        provider = null;
        publishedSignature = null;
        lastPlaying = null;
        lastPositionMs = -1L;
        // SDK 一旦失败就一直失败，换个进程重新建才有意义。
        unavailable = false;
    }

    private static String processName(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            String name = Application.getProcessName();
            return name == null ? context.getPackageName() : name;
        }
        return context.getPackageName();
    }
}
