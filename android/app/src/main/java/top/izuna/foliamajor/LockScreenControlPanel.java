package top.izuna.foliamajor;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;

import androidx.core.graphics.drawable.DrawableCompat;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 音乐锁屏底部的控制条：封面 + 歌名 + 歌手/专辑 + 时长 + 上一首 / 下一首。
 *
 * ## 为什么它是另开一个子窗口，而不是画进 Activity 的内容视图
 *
 * 锁屏上真正显示画面的是 `WallpaperOverlay` 那一层（一个挂在 Activity token 上的
 * `TYPE_APPLICATION_PANEL` 全屏窗口，见 LockScreenMusicActivity 的说明）。
 * 它盖在 Activity 的内容视图**之上**，塞进内容视图的任何控件都会被压住 —— 看得见摸不着。
 * 同级的子窗口按添加顺序叠，这一层在叠层之后添加，所以落在最上面。
 *
 * ## 控制指令走通知栏那条路
 *
 * 上一首 / 下一首不做成"原生直接切歌"：真正知道下一首是什么的只有 Web 层
 * （队列、随机、自动混播都在那边）。这里发的是和通知栏按钮完全相同的广播，
 * 交给 `FoliaCommandReceiver` → Capacitor 插件 → Web 层，行为与点通知栏一致。
 *
 * ## 数据从 `FoliaPlaybackService.snapshot()` 拉，不订阅推送
 *
 * 锁屏页活在另一个组件里，随时会被系统回收重建（转屏、内存紧张）。
 * 推的模式要维护订阅表，还要处理"推送时锁屏页还没起来"；而通知栏本来就在服务里
 * 维护着一份完整缓存，取一份 volatile 快照来读最省事 —— 页面起来读一次，之后每秒读一次。
 */
final class LockScreenControlPanel {

    /** 上滑退出在面板上也照样生效：这一条不设的话，面板那块区域就成了"滑不动的死区"。 */
    private static final float SWIPE_UP_DP = 64f;
    private static final float SWIPE_MAX_SIDE_RATIO = 0.6f;
    /** 每秒刷一次：封面与歌名是换歌才变的慢字段，播放位置在这条面板上只到秒。 */
    static final long REFRESH_INTERVAL_MS = 1000L;

    /** 服务还没推过信息时的占位。 */
    private static final String NO_TRACK_TEXT = "未在播放";

    private final Activity activity;
    private View panel = null;
    private ImageView artworkView = null;
    private TextView titleView = null;
    private TextView subtitleView = null;
    private TextView durationView = null;

    /** 进度条：整条可拖，抬手才真的 seek（拖动中只本地预览，不打扰播放器）。 */
    private android.widget.FrameLayout progressHost = null;
    private View progressFill = null;
    private boolean seeking = false;
    /** 拖动中的预览位置；-1 = 不预览（跟着播放走）。 */
    private long seekPreviewMs = -1L;

    private boolean tracking = false;
    private boolean gestureConsumed = false;
    private float startX = 0f;
    private float startY = 0f;

    LockScreenControlPanel(Activity activity) {
        this.activity = activity;
    }

    /**
     * 建好视图并挂到锁屏页的窗口上。
     *
     * 必须等 decorView 真的贴上窗口之后才拿得到 token —— 在 onCreate 里直接读是 null，
     * 以 PANEL 类型挂上去会被立刻拒绝（表现是"面板没出现，日志也不报错"）。
     */
    void attach() {
        if (panel != null) {
            return;
        }
        float density = activity.getResources().getDisplayMetrics().density;
        int margin = Math.round(14f * density);
        int cover = Math.round(52f * density);
        int padding = Math.round(12f * density);
        int radius = Math.round(18f * density);

        GradientDrawable background = new GradientDrawable();
        background.setShape(GradientDrawable.RECTANGLE);
        /*
         * 底色压得很淡（约 22% 黑）。
         *
         * 以前是 80% 的实心黑，在锁屏上就是一坨突兀的黑块。锁屏的美感本来就在
         * 壁纸本身，这一层该做的是"浮在上面"而不是"盖住它"。
         * 可读性由**文字阴影**来兜（见 addTextShadow），而不是靠把底涂黑 ——
         * 阴影对任何壁纸都有效，还不会挡住画面。
         */
        background.setColor(0x38000000);
        background.setCornerRadius(radius);
        // 一圈极淡的白边：全透明时边界会"糊"进背景里，看不出这是一块可点的区域。
        background.setStroke(Math.max(1, Math.round(density)), 0x24FFFFFF);

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(padding, padding, padding, padding);
        root.setBackground(background);

        artworkView = new ImageView(activity);
        artworkView.setLayoutParams(new LinearLayout.LayoutParams(cover, cover));
        artworkView.setScaleType(ImageView.ScaleType.CENTER_CROP);
        // 圆角靠裁剪，而不是再垫一层框：垫框在有透明像素的封面上会露出角。
        GradientDrawable coverShape = new GradientDrawable();
        coverShape.setShape(GradientDrawable.RECTANGLE);
        coverShape.setColor(0x33FFFFFF);
        coverShape.setCornerRadius(Math.round(10f * density));
        artworkView.setBackground(coverShape);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            artworkView.setClipToOutline(true);
        }
        root.addView(artworkView);

        LinearLayout textColumn = new LinearLayout(activity);
        textColumn.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        textParams.setMarginStart(Math.round(12f * density));
        textParams.setMarginEnd(Math.round(8f * density));
        textColumn.setLayoutParams(textParams);

        titleView = new TextView(activity);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        titleView.setTypeface(titleView.getTypeface(), android.graphics.Typeface.BOLD);
        addTextShadow(titleView);
        textColumn.addView(titleView);

        subtitleView = new TextView(activity);
        subtitleView.setSingleLine(true);
        subtitleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        subtitleView.setTextColor(0xD9FFFFFF);
        subtitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        addTextShadow(subtitleView);
        textColumn.addView(subtitleView);

        durationView = new TextView(activity);
        durationView.setSingleLine(true);
        durationView.setTextColor(0xCCFFFFFF);
        durationView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        addTextShadow(durationView);
        textColumn.addView(durationView);

        // 进度条：文字列下面那一整条，可拖。见 buildProgressBar。
        buildProgressBar(textColumn, density);
        root.addView(textColumn);

        int buttonSize = Math.round(40f * density);
        root.addView(buildButton("previous", buttonSize));
        root.addView(buildButton("next", buttonSize));

        /*
         * 面板本身要接住上滑：它是一块可触摸的窗口，事件到这里就为止了，
         * 不会再到 Activity 的 dispatchTouchEvent —— 少了这一段，底部这一条
         * 就成了"上滑退不出去"的死区（而底部恰恰是用户最常滑的地方）。
         *
         * 返回 false 是不吃事件：按钮的点击还要照常往下走。
         */
        root.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tracking = true;
                    gestureConsumed = false;
                    startX = event.getRawX();
                    startY = event.getRawY();
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (tracking && !gestureConsumed && isSwipeUp(event)) {
                        tracking = false;
                        gestureConsumed = true;
                        dismissHost();
                    }
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (tracking && !gestureConsumed && isSwipeUp(event)) {
                        gestureConsumed = true;
                        dismissHost();
                    }
                    tracking = false;
                    break;
                default:
                    break;
            }
            return false;
        });

        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                screenWidth - margin * 2,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
                // 可触摸（按钮要能点）、不抢焦点、窗口外的事件交还给后面的窗口。
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        // 抬离手势条一点：贴着底边的话既容易被系统手势吃掉，也容易被误触。
        params.y = Math.round(26f * density);
        params.token = activity.getWindow().getDecorView().getWindowToken();

        try {
            WindowManager manager = (WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE);
            manager.addView(root, params);
            panel = root;
            refresh();
        } catch (Throwable error) {
            // token 失效 / ROM 拒绝：锁屏页照常用（上滑与 ✕ 都还在），只是没有这块面板。
            panel = null;
            android.util.Log.w("FoliaLockScreen", "Could not add the control panel", error);
        }
    }

    void detach() {
        if (panel == null) {
            return;
        }
        try {
            ((WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE)).removeView(panel);
        } catch (Throwable ignored) {
            // 已经被摘掉了。
        }
        panel = null;
        artworkView = null;
        titleView = null;
        subtitleView = null;
        durationView = null;
        progressHost = null;
        progressFill = null;
        seeking = false;
        seekPreviewMs = -1L;
    }

    /** 按当前媒体信息重画一次。服务还没推过信息时显示占位文案。 */
    void refresh() {
        if (panel == null) {
            return;
        }
        FoliaPlaybackService.MediaSnapshot info = FoliaPlaybackService.snapshot();
        String title = info == null ? "" : info.title;
        if (title == null || title.isEmpty()) {
            // 服务还没推过信息（刚起来那一两秒）。这一层是中文界面，写死即可 ——
            // 走资源的话要为三个语言各备一份，而这行字只在锁屏上待一瞬间。
            title = NO_TRACK_TEXT;
        }
        titleView.setText(title);

        String artist = info == null ? null : info.artist;
        String album = info == null ? null : info.album;
        StringBuilder subtitle = new StringBuilder();
        if (artist != null && !artist.isEmpty()) {
            subtitle.append(artist);
        }
        if (album != null && !album.isEmpty()) {
            if (subtitle.length() > 0) {
                subtitle.append(" · ");
            }
            subtitle.append(album);
        }
        subtitleView.setText(subtitle.toString());
        subtitleView.setVisibility(subtitle.length() > 0 ? View.VISIBLE : View.GONE);

        long durationMs = info == null ? 0L : info.durationMs;
        long positionMs = info == null ? 0L : info.positionMs;
        if (durationMs > 0) {
            durationView.setText(formatTime(positionMs) + " / " + formatTime(durationMs));
        } else {
            durationView.setText(positionMs > 0 ? formatTime(positionMs) : "");
        }
        durationView.setVisibility(durationView.getText().length() > 0 ? View.VISIBLE : View.GONE);

        artworkView.setImageBitmap(info == null ? null : info.artwork);
        // 拖动中不覆盖：那一段位置由手指说了算，被推过来的旧位置盖掉会跳回去。
        if (!seeking) {
            applyProgress();
        }
    }

    /**
     * 文字阴影：底色压淡之后，可读性全靠它。
     *
     * 不用"把底涂黑"来保证可读 —— 那正是上一版难看的原因（锁屏上一坨黑块）。
     * 阴影对任何壁纸都成立，而且不挡画面。
     */
    private static void addTextShadow(TextView view) {
        view.setShadowLayer(6f, 0f, 1f, 0xAA000000);
    }

    /**
     * 进度条。
     *
     * 条本身只有 3dp 高，但**触摸区域给了 22dp**：按视觉高度做热区的话手指根本按不准，
     * 而锁屏上用户多半是单手盲操。轨道与进度是两块叠起来的 View，进度改宽度即可，
     * 不用自绘（自绘要处理硬件加速下的 invalidate 时机，没必要）。
     *
     * 拖动只改本地预览，抬手才发一次 seek：一路发下去的话，播放器会被几十条
     * seek 指令淹没（每条都要重新解一次码、重新定位缓冲），拖完反而卡顿。
     */
    private void buildProgressBar(LinearLayout parent, float density) {
        int barHeight = Math.max(2, Math.round(3f * density));
        int touchHeight = Math.round(22f * density);
        float radius = barHeight / 2f;

        progressHost = new android.widget.FrameLayout(activity);
        progressHost.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, touchHeight));
        // 顶部留一点空隙，别贴着时长那一行。
        ((LinearLayout.LayoutParams) progressHost.getLayoutParams())
                .setMargins(0, Math.round(4f * density), 0, 0);

        GradientDrawable trackShape = new GradientDrawable();
        trackShape.setShape(GradientDrawable.RECTANGLE);
        trackShape.setColor(0x33FFFFFF);
        trackShape.setCornerRadius(radius);
        View track = new View(activity);
        android.widget.FrameLayout.LayoutParams trackParams =
                new android.widget.FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, barHeight, Gravity.CENTER_VERTICAL);
        track.setLayoutParams(trackParams);
        track.setBackground(trackShape);
        progressHost.addView(track);

        GradientDrawable fillShape = new GradientDrawable();
        fillShape.setShape(GradientDrawable.RECTANGLE);
        fillShape.setColor(0xFFFFFFFF);
        fillShape.setCornerRadius(radius);
        progressFill = new View(activity);
        progressFill.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                0, barHeight, Gravity.CENTER_VERTICAL));
        progressFill.setBackground(fillShape);
        progressHost.addView(progressFill);

        progressHost.setOnTouchListener((view, event) -> {
            int width = view.getWidth();
            if (width <= 0) {
                return true;
            }
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    seeking = true;
                    seekPreviewMs = positionFromRatio(event.getX() / (float) width);
                    applyProgress();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (seeking) {
                        seekPreviewMs = positionFromRatio(event.getX() / (float) width);
                        applyProgress();
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (seeking) {
                        long target = positionFromRatio(event.getX() / (float) width);
                        seeking = false;
                        seekPreviewMs = -1L;
                        if (target >= 0L) {
                            FoliaPlaybackService.sendPlaybackCommand(activity, "seek", target);
                        }
                    }
                    return true;
                default:
                    return true;
            }
        });
        parent.addView(progressHost);
    }

    /** 拖动位置换算成毫秒。没有时长（直播 / 没推过来）就返回 -1，表示这次拖动无效。 */
    private long positionFromRatio(float ratio) {
        FoliaPlaybackService.MediaSnapshot info = FoliaPlaybackService.snapshot();
        long duration = info == null ? 0L : info.durationMs;
        if (duration <= 0L) {
            return -1L;
        }
        float clamped = Math.min(1f, Math.max(0f, ratio));
        return Math.round(duration * clamped);
    }

    /** 把进度条画到当前（或预览的）位置。 */
    private void applyProgress() {
        if (progressFill == null || progressHost == null) {
            return;
        }
        int width = progressHost.getWidth();
        if (width <= 0) {
            return;
        }
        FoliaPlaybackService.MediaSnapshot info = FoliaPlaybackService.snapshot();
        long duration = info == null ? 0L : info.durationMs;
        long position = seekPreviewMs >= 0L
                ? seekPreviewMs
                : (info == null ? 0L : info.positionMs);
        float ratio = duration > 0L ? Math.min(1f, Math.max(0f, position / (float) duration)) : 0f;
        android.widget.FrameLayout.LayoutParams params =
                (android.widget.FrameLayout.LayoutParams) progressFill.getLayoutParams();
        params.width = Math.round(width * ratio);
        progressFill.setLayoutParams(params);
        if (seekPreviewMs >= 0L && durationView != null && duration > 0L) {
            // 拖动中就把时间跟着动：等 Web 回推的话，手指和文字会差一拍。
            durationView.setText(formatTime(position) + " / " + formatTime(duration));
        }
    }

    private View buildButton(String command, int size) {
        ImageView button = new ImageView(activity);
        button.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        // 用 App 里同一套图标（lucide 的 skip-back / skip-forward 重画成矢量，
        // 见 res/drawable/folia_skip_*.xml）—— 系统自带的 ic_media_* 是 Android 2 时代的
        // 老资源，形状过时、还常常是低分辨率位图，放在这条面板上很突兀。
        int drawableId = "next".equals(command)
                ? R.drawable.folia_skip_next
                : R.drawable.folia_skip_previous;
        Drawable icon = androidx.core.content.ContextCompat.getDrawable(activity, drawableId);
        if (icon != null) {
            Drawable tinted = DrawableCompat.wrap(icon).mutate();
            DrawableCompat.setTint(tinted, Color.WHITE);
            button.setImageDrawable(tinted);
        }
        button.setContentDescription(command);
        button.setOnClickListener(view ->
                FoliaPlaybackService.sendPlaybackCommand(activity, command));
        return button;
    }

    private boolean isSwipeUp(MotionEvent event) {
        float dy = startY - event.getRawY();
        float dx = Math.abs(event.getRawX() - startX);
        float threshold = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                SWIPE_UP_DP, activity.getResources().getDisplayMetrics());
        return dy >= threshold && dx <= dy * SWIPE_MAX_SIDE_RATIO;
    }

    private void dismissHost() {
        if (activity instanceof LockScreenMusicActivity) {
            ((LockScreenMusicActivity) activity).dismissFromPanel();
        }
    }

    private static String formatTime(long ms) {
        long totalSeconds = Math.max(0L, ms / 1000L);
        long minutes = totalSeconds / 60L;
        long seconds = totalSeconds % 60L;
        return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
    }
}
