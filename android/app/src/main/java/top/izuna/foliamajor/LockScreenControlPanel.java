package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
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
import android.view.animation.Interpolator;
import android.view.animation.PathInterpolator;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;

/**
 * 音乐锁屏底部的控制条：退出（ˇ）+ 封面 + 歌名 + 歌手/专辑 + 时长 + 进度条 +
 * 上一首 / 播放暂停 / 下一首 / 喜欢。
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
    /**
     * 已喜欢那颗心的颜色：与面板里喜爱按钮按下去的 red-500 同一个色。
     * 通知栏那颗做不到（系统只按 alpha 染色），这条面板是我们自己画的，可以。
     */
    private static final int LIKE_TINT = 0xFFEF4444;
    /** 每秒刷一次：封面与歌名是换歌才变的慢字段，播放位置在这条面板上只到秒。 */
    static final long REFRESH_INTERVAL_MS = 1000L;

    /**
     * 退出动画的可调参数。
     *
     * 两段**拼接**播放（中间不留 delay），总时长 = upDuration + downDuration = 410ms，
     * 落在"400–450ms"这个窗口里。
     *
     * 第一段是 ease-out（起步快、末段慢，还带一点点回弹）把卡片向上"蓄"一下，
     * 第二段是 ease-in（起步慢、末段快）直接甩出屏幕 —— 一慢一快，才有
     * "顿一下再冲出去"的折返节奏。反过来接就变成"冲上去再慢慢沉下去"，完全不是一回事。
     */
    private static final class ExitMotion {
        /** 第一段：向上抬起的距离（dp）。 */
        static final float upDistance = 10f;
        /** 第一段时长（ms）。 */
        static final long upDuration = 130L;
        /** 第二段时长（ms）。 */
        static final long downDuration = 280L;
        /** 出屏之后额外多走的距离（dp）：留点余量，连圆角 / 阴影也彻底出屏。 */
        static final float overshoot = 20f;
        /** 手柄字号基准（sp）。 */
        static final float handleBaseSizeSp = 18f;
        /**
         * 手柄放大倍数。3 = 基准的三倍（54sp），1.5 = 再缩一半（27sp）。
         * 实测提醒：U+02C7 是变音符号，墨迹只占约 0.13em 高，
         * 所以"三倍"看上去仍然是个小符号 —— 调这一个数就行。
         */
        static final float handleScale = 1.5f;

        /** 第一段的缓动：ease-out + 轻微回弹（末段的 1.56 就是那一点过冲）。 */
        static final Interpolator upEasing =
                new PathInterpolator(0.34f, 1.56f, 0.64f, 1f);
        /** 第二段的缓动：ease-in，越滑越快。 */
        static final Interpolator downEasing =
                new PathInterpolator(0.55f, 0.06f, 0.68f, 0.19f);

        private ExitMotion() {
        }
    }

    /** 服务还没推过信息时的占位。 */
    private static final String NO_TRACK_TEXT = "未在播放";

    private final Activity activity;
    /**
     * 挂在锁屏页上的那个窗口的**根**：一层透明的外壳。真正有背景的是里面那张卡片。
     * 中间多这一层是为了退出动画 —— 见 runExitAnimation。
     */
    private View panel = null;
    /** 外壳里那张卡片（背景 + 内容）。退出动画作用在它身上。 */
    private View cardView = null;
    /**
     * 动画的"跑道"，分上下两条，平时都是 0 高，动画开始前才撑到实际需要的位移：
     * `exitHeadSpacer` 给**抬起**那 10dp 留上方空间，`exitSpacer` 给**下滑出屏**留下方空间。
     * 少了任何一条，卡片移出窗口边界的那一段都会被窗口裁掉（而不是盖在上层内容上）。
     */
    private View exitHeadSpacer = null;
    private View exitSpacer = null;
    /**
     * 两条跑道**当前**已经撑开到多少（px）。0 = 还没备。
     * 备好之后点击就只剩纯 translationY，见 prepareExitRunway。
     */
    private int preparedHeadRunway = 0;
    private int preparedBottomRunway = 0;
    private Animator exitAnimator = null;
    /** 退出动画已经在跑了：再点不该叠加第二遍。 */
    private boolean exiting = false;
    /** 卡片离屏幕底的常态距离，动画结束后复位要用。 */
    private int baseMarginY = 0;
    private ImageView artworkView = null;
    private TextView titleView = null;
    private TextView subtitleView = null;
    private TextView durationView = null;
    /** 「喜欢」那颗心。不能收藏时整颗隐藏 —— 这条面板上也没有"置灰"这回事。 */
    private ImageView likeButton = null;
    /** 播放 / 暂停。图标由快照里的 playing 决定，按下去不自己翻（见 togglePlayback）。 */
    private ImageView playPauseButton = null;

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

        /*
         * 外壳：一层**透明**的容器，卡片和那条"跑道"都挂在它身上。
         *
         * 窗口只有内容那么大，卡片要滑出屏幕就必须滑到窗口外面去 —— 而画出窗口边界的
         * 部分会被窗口裁掉（看上去是"陷进一条线里"，不是滑出去）。
         * 所以中间垫这一层：退出动画开始前，按需要的位移把**上、下两条跑道**撑开
         * （抬起走上面那条、下滑走下面那条），窗口跟着长出同样多，卡片本身一格不动，
         * 之后就全靠 translationY 了。详见 runExitAnimation。
         */
        LinearLayout shell = new LinearLayout(activity);
        shell.setOrientation(LinearLayout.VERTICAL);

        LinearLayout root = new LinearLayout(activity);
        /*
         * 面板改成两行：上面是封面 / 文字 / 喜欢，下面是进度条 + 播放控制。
         *
         * 加播放暂停之前，这一条是**一行**排下来的（封面 + 文字列 + 上一首 + 下一首 + 喜欢）。
         * 再往里塞第四个键，文字列在 360dp 的机器上只剩 80dp 出头，歌名会被截成一个词 ——
         * 而播放暂停恰恰是最常用的那个键，不能为了它把标题挤没。
         * 顺带把进度条从文字列里提出来铺满整条面板：原来它只有 100dp 出头，很难拖准。
         */
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padding, padding, padding, padding);
        root.setBackground(background);

        LinearLayout infoRow = new LinearLayout(activity);
        infoRow.setOrientation(LinearLayout.HORIZONTAL);
        infoRow.setGravity(Gravity.CENTER_VERTICAL);

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
        infoRow.addView(artworkView);

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

        infoRow.addView(textColumn);

        int buttonSize = Math.round(40f * density);
        likeButton = buildLikeButton(buttonSize);
        infoRow.addView(likeButton);

        /*
         * 退出（ˇ）：面板的**第一行**，在封面 / 歌名之上，而不是另开一个窗口。
         *
         * 原先它是锁屏页左上角那个独立圆钮（同级的 TYPE_APPLICATION_PANEL 子窗口）。
         * 融进来之后：它跟着面板一起出现 / 一起重排（换宿主后的 reorder 不再需要
         * 单独照顾它），也不再和面板割裂成两块浮层。
         *
         * 放最上面而不是夹在播放键上面：这一页是"从底部浮上来"的一块，收起它的手柄
         * 在最上沿才符合直觉（和底部抽屉的手柄同向）；夹进播放键那一行的上方的话，
         * 一场误触就是整页退掉，而那一行的周围全是高频操作。
         *
         * 符号从 ✕ 换成 ˇ：这一行只有 20dp 高，✕ 那种圆形底衬的造型在这里放不下，
         * 而 ˇ 读起来就是「收起」，和它向下退出这一页的动作也对得上。
         */
        root.addView(buildExitHandle(density));

        root.addView(infoRow);

        // 进度条：铺满面板宽度，可拖。见 buildProgressBar。
        buildProgressBar(root, density);

        /*
         * 控制行：上一首 / 播放暂停 / 下一首，居中。
         *
         * 居中而不是靠右：底部这块是单手盲操区域，居中的三个键左右都够得着；
         * 靠右的话「上一首」会挤到右下角，大拇指横过来才按得到。
         */
        LinearLayout controlRow = new LinearLayout(activity);
        controlRow.setOrientation(LinearLayout.HORIZONTAL);
        controlRow.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams controlParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        controlParams.topMargin = Math.round(6f * density);
        controlRow.setLayoutParams(controlParams);

        View previousButton = buildButton("previous", buttonSize);
        ((LinearLayout.LayoutParams) previousButton.getLayoutParams())
                .setMarginEnd(Math.round(10f * density));
        controlRow.addView(previousButton);
        controlRow.addView(buildPlayPauseButton(Math.round(44f * density)));
        View nextButton = buildButton("next", buttonSize);
        ((LinearLayout.LayoutParams) nextButton.getLayoutParams())
                .setMarginStart(Math.round(10f * density));
        controlRow.addView(nextButton);

        root.addView(controlRow);

        /*
         * 抬起那条跑道在**卡片之上**：第一段是向上走 10dp，而窗口的上边界就压在卡片
         * 上沿上，抬起的那一段会画出窗口外被裁掉 —— 表现是"卡片顶部被上面那层
         * （锁屏叠层）挡掉一截"。所以上方也要先留出空间。
         */
        View headSpacer = new View(activity);
        shell.addView(headSpacer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0));

        shell.addView(root, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // 退出动画的"跑道"：常态 0 高，动画开始前按卡片的实际位置撑开。
        View spacer = new View(activity);
        shell.addView(spacer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0));

        /*
         * 面板本身要接住上滑：它是一块可触摸的窗口，事件到这里就为止了，
         * 不会再到 Activity 的 dispatchTouchEvent —— 少了这一段，底部这一条
         * 就成了"上滑退不出去"的死区（而底部恰恰是用户最常滑的地方）。
         *
         * 返回 false 是不吃事件：按钮的点击还要照常往下走。
         */
        shell.setOnTouchListener((view, event) -> {
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

        /*
         * 窗口挂上**之前**就把跑道定好 —— 这是"刚亮屏那下面板不抽搐"的关键。
         *
         * 先填内容（refresh 现在看 cardView 而不是 panel，所以能在 addView 之前调），
         * 再自己 measure 一次拿到卡片高度，据此算出跑道长度：
         *
         *     卡片下沿离屏幕底 = margin
         *     出屏距离 travel  = margin + 卡片高 + overshoot
         *
         * 于是 addView 时窗口尺寸和位置**一次给全**，之后不再改窗口。
         * 早先是在挂上之后再撑（哪怕几何上做了补偿），窗口尺寸和 params.y 分两步落，
         * 中间那一帧卡片就会跳一下 —— 亮屏瞬间看得最清楚。
         */
        cardView = root;
        exitHeadSpacer = headSpacer;
        exitSpacer = spacer;
        preparedHeadRunway = 0;
        preparedBottomRunway = 0;
        refresh();

        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        root.measure(View.MeasureSpec.makeMeasureSpec(screenWidth - margin * 2,
                        View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int cardHeight = Math.max(root.getMeasuredHeight(), Math.round(48f * density));
        growExitRunway(
                Math.round(ExitMotion.upDistance * density) + Math.round(2f * density),
                margin + cardHeight
                        + Math.round(ExitMotion.overshoot * density)
                        + Math.round(2f * density)
                        + Math.round(24f * density));

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
        /*
         * 下边距与两侧**取同一个值**：三边留白一致，面板读起来才是"居中浮在锁屏上"，
         * 而不是往下坠了一截（原来是 26dp，比两侧的 14dp 多出 12dp）。
         * 直接引用 margin，以后调两侧宽度时底部会跟着走，不用再改第二处。
         */
        // 卡片下沿要停在离屏幕底 margin 处；窗口底边则再往下让出整条跑道。
        baseMarginY = margin;
        params.y = baseMarginY - preparedBottomRunway;
        params.token = activity.getWindow().getDecorView().getWindowToken();

        try {
            WindowManager manager = (WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE);
            manager.addView(shell, params);
            panel = shell;
            exiting = false;

            /*
             * 兜底：上面是按**量出来**的卡片高度估的，真机上字体 / 排版差几 dp 有可能
             * 让实际需要更长一点。这里在首次绘制前拿真实位置复核一次 —— 常态下
             * growExitRunway 发现已经够长会直接返回，不做任何改动（也就不会抽搐）。
             * 挂在 preDraw 上而不是直接 post：那时要等布局真正跑完，
             * 才能量到卡片在屏幕上的位置（post 出去的那条消息可能排在首次遍历之前，
             * 量出来是 0）。这时卡片正在淡入，多一次 relayout 看不出来。
             */
            shell.getViewTreeObserver().addOnPreDrawListener(
                    new android.view.ViewTreeObserver.OnPreDrawListener() {
                        @Override
                        public boolean onPreDraw() {
                            shell.getViewTreeObserver().removeOnPreDrawListener(this);
                            if (panel == shell) {
                                prepareExitRunway();
                            }
                            return true;
                        }
                    });
        } catch (Throwable error) {
            // token 失效 / ROM 拒绝：锁屏页照常用（上滑退出还在），只是没有这块面板。
            // 注意退出那个 ˇ 现在是面板的一行，会跟着一起没了 —— 能拒绝子窗口的 ROM 是
            // 极少数，而上滑那条路挂在 Activity 自己的窗口上，不受这里影响。
            panel = null;
            cardView = null;
            exitHeadSpacer = null;
            exitSpacer = null;
            preparedHeadRunway = 0;
            preparedBottomRunway = 0;
            android.util.Log.w("FoliaLockScreen", "Could not add the control panel", error);
        }
    }

    void detach() {
        if (panel == null) {
            return;
        }
        /*
         * 动画状态要清干净：它持着 cardView 的引用，而卡片马上就要跟着窗口一起没了。
         * detach + attach 是这条面板唯一的重排手段（见 LockScreenMusicActivity），
         * 漏掉这一句的话，下一轮 attach 出来的还是一张"已经滑出屏幕"的卡片。
         */
        if (exitAnimator != null) {
            exitAnimator.cancel();
            exitAnimator = null;
        }
        exiting = false;
        try {
            ((WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE)).removeView(panel);
        } catch (Throwable ignored) {
            // 已经被摘掉了。
        }
        panel = null;
        cardView = null;
        exitHeadSpacer = null;
        exitSpacer = null;
        preparedHeadRunway = 0;
        preparedBottomRunway = 0;
        artworkView = null;
        titleView = null;
        subtitleView = null;
        durationView = null;
        progressHost = null;
        progressFill = null;
        likeButton = null;
        playPauseButton = null;
        seeking = false;
        seekPreviewMs = -1L;
    }

    /** 按当前媒体信息重画一次。服务还没推过信息时显示占位文案。 */
    void refresh() {
        // 看卡片而不是窗口：attach 时要在 addView **之前**先填好内容（才能量到真实高度）。
        if (cardView == null) {
            return;
        }
        /*
         * 退出动画这 410ms 里不刷新：每秒那一次 refresh 会改文字 → 卡片失效重绘，
         * 正好毁掉动画期间钉的那层硬件层（见 runExitAnimation），白掉几帧。
         */
        if (exiting) {
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

        // 「喜欢」：当前这首歌能收藏才显示。这条面板是我们自己画的，颜色说了算，
        // 所以这里能真的画成红的 —— 通知栏那颗不行，系统只按 alpha 给图标染一个色，
        // 那边只能靠实心 / 空心表达状态。
        if (likeButton != null) {
            boolean canLike = info != null && info.canLike;
            likeButton.setVisibility(canLike ? View.VISIBLE : View.GONE);
            if (canLike) {
                likeButton.setImageDrawable(tintedDrawable(
                        info.liked ? R.drawable.folia_heart_filled : R.drawable.folia_heart,
                        info.liked ? LIKE_TINT : Color.WHITE));
                likeButton.setContentDescription(info.liked ? "取消喜欢" : "喜欢");
            }
        }

        // 拖动中不覆盖：那一段位置由手指说了算，被推过来的旧位置盖掉会跳回去。
        if (!seeking) {
            applyProgress();
        }

        /*
         * 播放 / 暂停那颗键：图标一律按快照里的 playing 画。
         *
         * 和「喜欢」同一套规矩 —— 按下去不自己翻图标。暂停指令要走 Web 层绕一圈，
         * 中途可能失败（音源断流、解码异常），自己先翻的话那颗键会停在错的状态上，
         * 而锁屏上用户只能靠它判断"到底播没播"。慢一拍由 togglePlayback 里那次
         * 补刷来兜。
         */
        if (playPauseButton != null) {
            boolean playing = info != null && info.playing;
            playPauseButton.setImageDrawable(tintedDrawable(
                    playing ? R.drawable.folia_pause : R.drawable.folia_play, Color.WHITE));
            playPauseButton.setContentDescription(playing ? "暂停" : "播放");
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

    /**
     * 播放 / 暂停。
     *
     * 比左右两个切歌键大一圈（44dp 对 40dp）：它是这条面板上的主操作，
     * 也是唯一一个"盲操时按错代价最大"的键（按到切歌会直接把这首歌丢掉）。
     *
     * 图标不在这里定死，交给 refresh 按快照里的 playing 画 —— 面板随时可能
     * 在暂停状态下被重建（转屏、宿主交接），按挂载那一刻的状态画会画反。
     */
    private ImageView buildPlayPauseButton(int size) {
        ImageView button = new ImageView(activity);
        button.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        button.setContentDescription("播放");
        button.setOnClickListener(view -> togglePlayback());
        playPauseButton = button;
        return button;
    }

    /**
     * 退出这一页的 ˇ：一条铺满面板宽度的细条，是卡片的**第一行**（在封面 / 歌名之上）。
     *
     * 高度 20dp，**横向整条都是热区**（判定区域 = 控件高度 × 横向窗口内所有区域）。
     *
     * 不画圆钮底衬、用面板同一块背景：它是「把这一页收起来」，不是和播放 / 切歌
     * 并列的第四个操作，视觉上不该去抢它们的位置。可读性照旧交给文字阴影。
     *
     * ## 触摸为什么自己接，不用 OnClickListener
     *
     * 这一条按下之后必须把事件**吃掉**（不然它拿不到抬起那一下，也就认不出点击），
     * 而父布局只在 ACTION_DOWN 时把事件往子 View 里派一次 —— 一旦被吃掉，后面那串
     * MOVE 就再也到不了外壳，于是「从这条细条起手上滑」退不出去（这恰恰是拇指最常
     * 起手的地方）。所以这里自己判：上滑照旧即时退场，抬起且没滑动才算点击。
     *
     * 点击走的是 runExitAnimation() → dismissHost() → Activity.dismiss()：
     * 和原来左上角那个 ✕ 完全同一条路（记"用户主动退场"、顺手解掉无密码的锁屏）。
     */
    private View buildExitHandle(float density) {
        int height = Math.round(20f * density);

        ExitHandleView handle = new ExitHandleView(activity);
        handle.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, height));
        // 面板自身的 padding 已经给了上边距，这里只补一点到下沿。
        ((LinearLayout.LayoutParams) handle.getLayoutParams())
                .bottomMargin = Math.round(2f * density);
        handle.setContentDescription("退出");
        handle.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tracking = true;
                    gestureConsumed = false;
                    startX = event.getRawX();
                    startY = event.getRawY();
                    break;
                case MotionEvent.ACTION_MOVE:
                    // 滑到位就走，不等抬手（和外壳那条同一个规矩）。
                    if (tracking && !gestureConsumed && isSwipeUp(event)) {
                        tracking = false;
                        gestureConsumed = true;
                        dismissHost();
                    }
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (tracking && !gestureConsumed) {
                        if (isSwipeUp(event)) {
                            dismissHost();
                        } else if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                            runExitAnimation();
                        }
                    }
                    tracking = false;
                    break;
                default:
                    break;
            }
            return true;
        });
        return handle;
    }

    /**
     * 按卡片**当前**的位置把上下两条跑道撑开。面板挂上、布局跑完那一帧就调一次
     * （见 attach 里的 preDraw），点击时通常就不用再动了。
     *
     * 多留一点余量（SLACK）：换歌后卡片可能变高（歌名换行），
     * 那时出屏距离会变大一点，有余量就不用再补一次 relayout。
     */
    private void prepareExitRunway() {
        if (panel == null || cardView == null || exitSpacer == null || exitHeadSpacer == null) {
            return;
        }
        float density = activity.getResources().getDisplayMetrics().density;
        int slack = Math.round(24f * density);
        growExitRunway(Math.round(ExitMotion.upDistance * density) + Math.round(2f * density),
                measureExitTravel() + Math.round(2f * density) + slack);
    }

    /** 出屏要走的距离：卡片**上沿**到屏幕底，再加余量。按真实位置算，不写死。 */
    private int measureExitTravel() {
        int overshoot = Math.round(ExitMotion.overshoot
                * activity.getResources().getDisplayMetrics().density);
        int[] location = new int[2];
        cardView.getLocationOnScreen(location);
        int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
        int travel = screenHeight - location[1] + overshoot;
        if (travel < overshoot) {
            // 还没布局完（拿不到位置）时至少也要滑出屏幕，别把动画做成 0。
            travel = screenHeight;
        }
        return travel;
    }

    /**
     * 撑开跑道，并保证卡片**一格不动**（整套几何的前提）：
     *
     *   · 上面的跑道长出 T：窗口变高 T，上边界就往上抬 T，卡片跟着往上跑 T ——
     *     所以窗口的下边界也得同步往下挪，把它顶回原位；
     *   · 下面的跑道长出 B：窗口下边界往下走 B，卡片位置不受影响。
     *
     * 合起来就是把窗口"拉长"但保持卡片不动：params.y（gravity=BOTTOM，
     * 是下边界到屏幕底的距离）减少 B，下边界就正好下落 B。
     * 于是净结果：上边界抬高 T、下边界下落 B、卡片原地不动，上下都留出了跑道。
     *
     * 已经够长就直接返回 —— 这是"点击不卡"的关键：常态下点击时这一趟什么都不做。
     */
    private void growExitRunway(int headRunway, int bottomRunway) {
        if (cardView == null || exitSpacer == null || exitHeadSpacer == null) {
            return;
        }
        int head = Math.max(headRunway, preparedHeadRunway);
        int bottom = Math.max(bottomRunway, preparedBottomRunway);
        if (head == preparedHeadRunway && bottom == preparedBottomRunway) {
            return;
        }
        exitHeadSpacer.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, head));
        exitSpacer.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, bottom));
        preparedHeadRunway = head;
        preparedBottomRunway = bottom;
        /*
         * 还没挂上窗口（attach 里第一次调）就到此为止：那时候只要把跑道撑好，
         * 窗口参数在 addView 时带着最终值一次给全，不会再有第二次改动。
         */
        if (panel == null) {
            return;
        }
        WindowManager.LayoutParams params = (WindowManager.LayoutParams) panel.getLayoutParams();
        if (params != null) {
            params.y = baseMarginY - bottom;
            try {
                ((WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE))
                        .updateViewLayout(panel, params);
            } catch (Throwable error) {
                // 窗口那边出状况也别把动画吞掉：继续跑，用户至少看得到东西滑走。
                android.util.Log.w("FoliaLockScreen", "Could not grow the panel window", error);
            }
        }
    }

    /**
     * 退出动画：先向上"蓄"一下，再向下甩出屏幕。
     *
     * ## 为什么窗口要先"长出"一段
     *
     * 这个窗口是按内容 WRAP_CONTENT 来的，卡片一往下走就出了窗口的下边界，
     * 而画出窗口边界的部分会被窗口直接裁掉 —— 看到的是"陷进一条线里"，不是滑出屏幕。
     * 所以先把 spacer 撑到实际要走的距离、窗口跟着向下长同样多（长的那一段在屏幕外，
     * 看不见），再把窗口整体上移同样的量，卡片本身一格不动。之后就纯粹是
     * translationY —— 它是渲染层的变换，不走布局、不触发重排。
     *
     * ## 两段拼接
     *
     * ① 抬起：向上 10dp，130ms，ease-out（末段带一点过冲，所以会"弹"一下）。
     * ② 甩出：从抬起的位置一路向下直到完全出屏（位移按卡片**当前真实位置**算，不写死），
     *    280ms，ease-in（越滑越快）。
     * 用 AnimatorSet.playSequentially：第一段结束的那一帧就是第二段的起点，中间没有 delay。
     */
    private void runExitAnimation() {
        if (panel == null || cardView == null || exitSpacer == null
                || exitHeadSpacer == null || exiting) {
            return;
        }
        exiting = true;

        float density = activity.getResources().getDisplayMetrics().density;
        int upDistance = Math.round(ExitMotion.upDistance * density);
        int overshoot = Math.round(ExitMotion.overshoot * density);
        // 多留 2dp：spacer 正好等于位移的话，最后那一帧会贴在窗口边界上被切掉一条边。
        int runway = Math.round(2f * density);

        int[] location = new int[2];
        cardView.getLocationOnScreen(location);
        int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
        int travel = screenHeight - location[1] + overshoot;
        if (travel < overshoot) {
            // 还没布局完（拿不到位置）时至少也要滑出屏幕，别把动画做成 0。
            travel = screenHeight;
        }

        /*
         * 跑道在面板挂上时就备好了（prepareExitRunway），这里通常**什么都不用做** ——
         * 只有换歌后卡片变高、把余量吃掉时才会补一次。
         */
        growExitRunway(upDistance + runway, travel + runway);

        /*
         * 动画期间把卡片钉到**硬件层**上。
         *
         * 卡片上有带阴影的文字（setShadowLayer 的模糊很贵）和封面图，不钉层的话
         * 每一帧都要把整张卡片重画一遍 —— 这就是掉帧的来源。
         * 钉成一层之后只画一次，后面每帧只是挪这一层（渲染线程上的变换）。
         * 动画结束立刻还原：一直挂着会白占一块显存。
         */
        cardView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        ObjectAnimator lift = ObjectAnimator.ofFloat(cardView, View.TRANSLATION_Y,
                0f, -upDistance);
        lift.setDuration(ExitMotion.upDuration);
        lift.setInterpolator(ExitMotion.upEasing);

        /*
         * 终点是 translationY = travel（相对**原始位置**的位移），不是"抬起位置 + 到屏幕底
         * 的距离" —— 后者会少走抬起的那 10dp，卡片顶边正好卡在屏幕边缘上，露出一道边。
         */
        ObjectAnimator drop = ObjectAnimator.ofFloat(cardView, View.TRANSLATION_Y,
                -upDistance, travel);
        drop.setDuration(ExitMotion.downDuration);
        drop.setInterpolator(ExitMotion.downEasing);

        AnimatorSet motion = new AnimatorSet();
        motion.playSequentially(lift, drop);
        motion.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                releaseAnimationLayer();
                // 就停在屏幕外：这里不再动它，detach / attach 时整个重建，天然复位。
                exitAnimator = null;
                dismissHost();
            }

            @Override
            public void onAnimationCancel(Animator animation) {
                releaseAnimationLayer();
                exitAnimator = null;
            }
        });
        exitAnimator = motion;
        motion.start();
    }

    /** 撤掉动画期间给卡片加的那层硬件层（见 runExitAnimation）。 */
    private void releaseAnimationLayer() {
        if (cardView != null) {
            cardView.setLayerType(View.LAYER_TYPE_NONE, null);
        }
    }

    /**
     * 切换播放 / 暂停。
     *
     * 走的是和通知栏那颗播放键**完全相同**的一条路（广播 → FoliaCommandReceiver →
     * Capacitor 插件 → Web 层），原生不自己改播放状态机。
     *
     * 暂停这一下要额外做一件事：告诉叠层「这一轮锁屏别因为暂停而收起」。
     * 设置里「暂停时自动隐藏」默认是开的，不打招呼的话按下去整页（连同这颗播放键）
     * 三秒多之后就被收走，用户想续播只能解锁进 App —— 那条开关的本意是给桌面叠层省电，
     * 不该管到这一页上（这一页上有播放键，暂停是它的一部分功能）。
     */
    private void togglePlayback() {
        FoliaPlaybackService.MediaSnapshot info = FoliaPlaybackService.snapshot();
        boolean playing = info != null && info.playing;
        /*
         * 先钉住再发指令，顺序不能反：指令一到，Web 层立刻把 playing 翻成 false，
         * 巡检那一轮就可能把整页收掉 —— 那时再钉已经晚了。
         */
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(activity)
                .holdLockScreenWhilePaused(playing);
        FoliaPlaybackService.sendPlaybackCommand(activity, playing ? "pause" : "play");
        /*
         * 状态要经 Web 层绕一圈才回到快照里（这条面板是每秒拉一次的）。
         * 补刷两次让图标跟得上手指：第一次赶在最快的那条回路上，第二次兜住
         * 稍慢一点的（恢复播放时可能还要先拉流）。真没赶上，下一秒那次巡检也会对齐。
         */
        if (panel != null) {
            panel.postDelayed(this::refresh, 160L);
            panel.postDelayed(this::refresh, 520L);
        }
    }

    /**
     * 「喜欢」那颗心。
     *
     * 与上一首 / 下一首走同一条广播（"like"），最终落到 Web 层那个 handleLike ——
     * 和面板里的喜爱按钮是同一个动作。这里**不自己切换图标**：状态由服务推回来的
     * 快照决定（见 refresh），自己先翻的话，请求失败时这颗心会一直停在错的状态上。
     */
    private ImageView buildLikeButton(int size) {
        ImageView button = new ImageView(activity);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(size, size);
        params.setMarginStart(Math.round(4f * activity.getResources().getDisplayMetrics().density));
        button.setLayoutParams(params);
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        button.setContentDescription("喜欢");
        button.setOnClickListener(view ->
                FoliaPlaybackService.sendPlaybackCommand(activity, "like"));
        return button;
    }

    private Drawable tintedDrawable(int drawableId, int color) {
        Drawable icon = androidx.core.content.ContextCompat.getDrawable(activity, drawableId);
        if (icon == null) {
            return null;
        }
        Drawable tinted = DrawableCompat.wrap(icon).mutate();
        DrawableCompat.setTint(tinted, color);
        return tinted;
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

    /**
     * 退出手柄：一个**自绘**的 ˇ。
     *
     * 为什么不用 TextView：ˇ（U+02C7）是变音符号，它的墨迹贴在基线上方 0.6em 那一带，
     * 根本不在字身正中。TextView 那套排法是"把行盒居中"，放大三倍之后（54sp 的行盒
     * 有 60dp 以上），墨迹会被整个顶到这条 20dp 的细条**外面**去 —— 屏幕上看到的就是
     * 一条空白，或者一个被切掉一半的符号。
     *
     * 自绘就按**墨迹**居中：measure 出 bbox 再反推基线，放大多少、换什么字体都不跑位。
     */
    private static final class ExitHandleView extends View {

        private static final String GLYPH = "\u02C7";

        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Rect ink = new Rect();
        private final float textSizePx;

        ExitHandleView(Context context) {
            super(context);
            textSizePx = TypedValue.applyDimension(
                    TypedValue.COMPLEX_UNIT_SP,
                    ExitMotion.handleBaseSizeSp * ExitMotion.handleScale,
                    context.getResources().getDisplayMetrics());
            paint.setColor(0xE6FFFFFF);
            // 和歌名同一套阴影：这条面板的底色很淡，可读性全靠它。
            paint.setShadowLayer(6f, 0f, 1f, 0xAA000000);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            int width = getWidth();
            int height = getHeight();
            if (width <= 0 || height <= 0) {
                return;
            }
            float size = textSizePx;
            paint.setTextSize(size);
            paint.getTextBounds(GLYPH, 0, GLYPH.length(), ink);
            /*
             * 兜底：真有字体把 ˇ 画得比这一条还高，就按比例缩回去 ——
             * 宁可小一点，也不要一个被切掉一半的符号。
             */
            float limit = height * 0.86f;
            if (ink.height() > limit && ink.height() > 0) {
                size *= limit / ink.height();
                paint.setTextSize(size);
                paint.getTextBounds(GLYPH, 0, GLYPH.length(), ink);
            }
            // ink 的坐标是相对"绘制原点 + 基线"的，所以减掉 left / 取上下边的中点。
            float x = width / 2f - ink.left - ink.width() / 2f;
            float baseline = height / 2f - (ink.top + ink.bottom) / 2f;
            canvas.drawText(GLYPH, x, baseline, paint);
        }
    }
}
