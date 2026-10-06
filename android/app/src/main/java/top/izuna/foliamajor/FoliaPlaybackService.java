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
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;

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

    static boolean isRunning() {
        return running;
    }

    // 通知内容缓存：metadata 与 playbackState 是两次独立更新，
    // 每次都基于这些字段重建整条通知，而不是互相覆盖。
    private String cachedTitle = "";
    private String cachedArtist = "";
    private String cachedAlbum = "";
    private Bitmap cachedArtwork;
    private int cachedState = PlaybackStateCompat.STATE_NONE;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        ensureMediaSession();
        // 就地前台化。
        //
        // Android 要求 startForegroundService() 之后 5 秒内调用 startForeground()，
        // 超时就抛 ForegroundServiceDidNotStartInTimeException 直接杀进程。
        // 放在 onCreate 里而不是等 onStartCommand 走完分支，是最稳的做法：
        // 无论后续 switch 走进哪个分支、甚至 intent 为 null，前台化都已经完成了。
        promoteToForeground();
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
                sendCommand("play");
            }

            @Override
            public void onPause() {
                sendCommand("pause");
            }

            @Override
            public void onSkipToNext() {
                sendCommand("next");
            }

            @Override
            public void onSkipToPrevious() {
                sendCommand("previous");
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
        });
        mediaSession.setActive(true);
        // 通知栏的播放/暂停等动作直接复用 MediaSession 的控制，不再各自维护一套。
        mediaSession.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_STOP)
                .setState(PlaybackStateCompat.STATE_NONE, 0, 1.0f)
                .build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action != null) {
            switch (action) {
                case ACTION_UPDATE_METADATA:
                    updateMetadata(intent);
                    break;
                case ACTION_UPDATE_STATE:
                    updatePlaybackState(intent);
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

    /**
     * 把服务顶到前台。
     *
     * 通知构造失败不该把整个应用带走：startForeground 抛异常意味着
     * 系统判定「前台服务没起来」，紧接着就是进程被杀，用户看到的就是闪退。
     * 这里兜住异常，宁可没有通知也要保住播放。
     */
    private void promoteToForeground() {
        try {
            startForeground(NOTIFICATION_ID, buildForegroundNotification());
        } catch (Throwable error) {
            Log.e(TAG, "startForeground failed; keeping the service alive without it", error);
        }
    }

    private void updateMetadata(Intent intent) {
        String title = intent.getStringExtra(EXTRA_TITLE);
        String artist = intent.getStringExtra(EXTRA_ARTIST);
        String album = intent.getStringExtra(EXTRA_ALBAND);
        String artworkBase64 = intent.getStringExtra(EXTRA_ARTWORK);
        long durationMs = intent.getLongExtra(EXTRA_DURATION, 0L);

        // 先更新缓存，再重建通知：metadata 与 state 是两次独立调用，
        // 任何一次都要能拿到完整的通知内容。
        if (title != null) cachedTitle = title;
        if (artist != null) cachedArtist = artist;
        if (album != null) cachedAlbum = album;
        Bitmap artwork = decodeArtwork(artworkBase64);
        if (artwork != null) {
            cachedArtwork = artwork;
        }

        MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, cachedTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, cachedArtist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, cachedAlbum);
        if (durationMs > 0) {
            builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        }
        if (cachedArtwork != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cachedArtwork);
        }

        if (mediaSession != null) {
            mediaSession.setMetadata(builder.build());
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

        PlaybackStateCompat.Builder builder = new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_STOP)
                .setState(compatState, positionMs, speed);
        if (mediaSession != null) {
            mediaSession.setPlaybackState(builder.build());
        }

        cachedState = compatState;
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
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                // 通知属于前台服务，用户无法手动划掉它（划掉就等于杀掉播放）。
                .setOngoing(true);

        // 通知栏的三个按钮：上一首 / 播放暂停 / 下一首。
        // 必须真的 addAction —— MediaStyle 的紧凑视图只是「从第 0/1/2 个 action 里挑出来显示」，
        // 不 addAction 就写 setShowActionsInCompactView(0,1,2) 是越界引用，等于白写。
        boolean playing = cachedState == PlaybackStateCompat.STATE_PLAYING;
        builder.addAction(buildAction(android.R.drawable.ic_media_previous, "上一首", "previous"));
        builder.addAction(playing
                ? buildAction(android.R.drawable.ic_media_pause, "暂停", "pause")
                : buildAction(android.R.drawable.ic_media_play, "播放", "play"));
        builder.addAction(buildAction(android.R.drawable.ic_media_next, "下一首", "next"));

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
    }

    // ---- Web 层（useCapacitorPlaybackBridge）通过这些常量与服务交互 ----

    static final String ACTION_UPDATE_METADATA = "top.izuna.foliamajor.action.UPDATE_METADATA";
    static final String ACTION_UPDATE_STATE = "top.izuna.foliamajor.action.UPDATE_STATE";
    static final String ACTION_STOP_FOREGROUND = "top.izuna.foliamajor.action.STOP_FOREGROUND";
    static final String ACTION_WEB_COMMAND = "top.izuna.foliamajor.action.WEB_COMMAND";
    static final String EXTRA_COMMAND = "command";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ARTIST = "artist";
    static final String EXTRA_ALBAND = "album";
    static final String EXTRA_ARTWORK = "artwork";
    static final String EXTRA_DURATION = "duration";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_POSITION = "position";
    static final String EXTRA_SPEED = "speed";
}
