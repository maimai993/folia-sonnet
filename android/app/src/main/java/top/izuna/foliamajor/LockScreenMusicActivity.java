package top.izuna.foliamajor;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * 音乐锁屏：一个**真正的锁屏页面**，不是悬浮窗。
 *
 * 为什么非得是 Activity：悬浮窗（TYPE_APPLICATION_OVERLAY）能不能画在锁屏之上，
 * 各家 ROM 说了算（MIUI / ColorOS 之类会拦，还有专门的「锁屏显示」开关）。
 * `FLAG_SHOW_WHEN_LOCKED` 从 API 27 起就 deprecated 了，官方给悬浮窗的替代方案
 * 根本不存在 —— 那条路只属于 Activity：manifest 的 `android:showWhenLocked`
 * 加 `Activity.setShowWhenLocked(true)`，是系统正式支持的「画在 keyguard 之上」。
 *
 * 这个 Activity 自己**几乎不画东西**（透明），画面由 `WallpaperOverlay` 那一层来画 ——
 * 它把窗口挂到这个 Activity 的 window token 上（TYPE_APPLICATION_PANEL），
 * 于是**锁屏上看到的就是桌面叠层那一层本身**：同一个 WebView、同一套可视化与歌词，
 * 不存在「复制一份浏览器」的两份状态。
 *
 * ## 为什么它必须吃触摸（这一条改过，别改回去）
 *
 * 最早这层是 `FLAG_NOT_TOUCHABLE` 的，指望手势穿到下面的 keyguard，
 * 这样"照常滑动解锁"。实测行不通：一个 `showWhenLocked` 的全屏 Activity 盖在
 * keyguard 之上时，系统会把 keyguard 判成被遮挡（occluded），
 * 那边的解锁手势根本收不到 —— 用户看到的就是「画面在，但怎么滑都解不开锁」。
 *
 * 既然注定要占住这块输入，就得自己把出口给用户：
 *  · **上滑退出**（和很多锁屏的解锁手势同向，符合直觉）；
 *  · **右下那个 ✕ 按钮**直接退出。
 * 退掉之后就是原本的锁屏，照常解锁。
 *
 * 生命周期由 `WallpaperOverlay` 的屏幕广播掌管：息屏时起、解锁（USER_PRESENT）或
 * 没在播放时结束。
 */
public class LockScreenMusicActivity extends Activity {

    /** 上滑超过这个距离才算"退出"，别把手抖当成指令。 */
    private static final float SWIPE_UP_DP = 72f;
    /** 横向漂移超过这个比例就不算上滑（那是横扫 / 切歌手势）。 */
    private static final float SWIPE_MAX_SIDE_RATIO = 0.6f;

    /** 底部的封面 / 歌名 / 时长 / 切歌面板（另开一个子窗口，见 LockScreenControlPanel）。 */
    private LockScreenControlPanel controlPanel = null;
    private final android.os.Handler panelHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable panelRefresh = new Runnable() {
        @Override
        public void run() {
            if (controlPanel != null) {
                controlPanel.refresh();
            }
            panelHandler.postDelayed(this, LockScreenControlPanel.REFRESH_INTERVAL_MS);
        }
    };

    private View exitButton = null;
    private boolean tracking = false;
    /** 这次手势已经触发过退出了：防止一次滑动里反复 dismiss（那正是"抽搐"的形状）。 */
    private boolean gestureConsumed = false;
    private float startX = 0f;
    private float startY = 0f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            // API 33 起子窗口不会自动继承：不设这一条，挂在它上面的叠层窗口
            // 反而会跑到 keyguard 后面去（静默，不报错也不显示）。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setInheritShowWhenLocked(true);
            }
        }
        /*
         * 注意这里**没有** FLAG_NOT_TOUCHABLE（见类注释）：不自己接住触摸，
         * 用户就既滑不动锁屏、也关不掉这一层 —— 等于被自己的锁屏页关在外面。
         * NOT_FOCUSABLE 保留：这只是展示层，不该抢走输入法 / 按键焦点。
         */
        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        setContentView(new View(this));
        handWindowTokenToOverlay();
        /*
         * ✕ 按钮和底部面板**单独**排队，不等叠层交接那一趟。
         *
         * 原来它们挂在 handWindowTokenToOverlay 的 post 里，那一趟要先去通知叠层换宿主，
         * 而换宿主会摘窗口 + 重建页面（整整一秒的加载与淡入）；
         * 被排在后面，于是"刚亮屏那一下"既没有按钮也没有手势 ——
         * 这正是「必须等它全部出现才退得掉」的一半。
         */
        getWindow().getDecorView().post(() -> {
            addExitButton();
            attachControlPanel();
        });
        panelHandler.postDelayed(panelRefresh, LockScreenControlPanel.REFRESH_INTERVAL_MS);
    }

    /** 底部那条控制条。挂不上（token / ROM 拒绝）也不影响锁屏页本身。 */
    private void attachControlPanel() {
        if (controlPanel != null) {
            return;
        }
        controlPanel = new LockScreenControlPanel(this);
        controlPanel.attach();
        /*
         * 叠层每次重挂都会跑到面板上面去（同级子窗口按添加顺序叠），
         * 所以这里登记一个回调：它一挂上，面板就摘了再挂一次回到最上层。
         * 少了这一段，面板会在锁屏期间莫名消失（换宿主 / 自愈重载之后就看不见了）。
         */
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .setWindowAttachedListener(this::reorderControlPanel);
    }

    /** 把面板重新排到叠层之上（detach + attach 是子窗口唯一的重排手段）。 */
    private void reorderControlPanel() {
        if (controlPanel == null) {
            return;
        }
        getWindow().getDecorView().post(() -> {
            if (controlPanel == null) {
                return;
            }
            controlPanel.detach();
            controlPanel.attach();
        });
    }

    /**
     * 上滑退出接在**窗口这一层**，而不是内容视图上。
     *
     * 挂在 root View 的 OnTouchListener 上时，只有事件被一路分派到那个 View 才收得到：
     * 页面刚起来那一段（窗口还没完成首帧、叠层还在淡入）事件常常到不了它，
     * 于是「刚亮屏就往上滑」毫无反应，必须等画面完整出现才滑得动。
     * `dispatchTouchEvent` 是窗口收到事件的**第一个**入口，比 View 分发更早、也更全。
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                tracking = true;
                gestureConsumed = false;
                startX = event.getRawX();
                startY = event.getRawY();
                break;
            case MotionEvent.ACTION_MOVE:
                /*
                 * 滑到位就走，**不等抬手**。
                 *
                 * 等 ACTION_UP 的话，手指在半路停一下、或者被锁屏的手势条 /
                 * 系统把事件收走（ACTION_CANCEL）就永远等不到那一击，退出不会发生 ——
                 * 用户看到的就是"滑了，没反应"。
                 */
                if (tracking && !gestureConsumed && isSwipeUp(event)) {
                    tracking = false;
                    gestureConsumed = true;
                    dismiss();
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (tracking && !gestureConsumed && isSwipeUp(event)) {
                    gestureConsumed = true;
                    dismiss();
                }
                tracking = false;
                break;
            default:
                break;
        }
        /*
         * 事件必须**继续往下传**：这一层只是顺便看一眼手势，不是来吃事件的。
         * 一旦在这里吞掉，✕ 按钮（挂在同级子窗口上）和锁屏自己的手势条都收不到了。
         */
        return super.dispatchTouchEvent(event);
    }

    /** 向上、够远、而且不是横着扫的 —— 才认它是"退出"。 */
    private boolean isSwipeUp(MotionEvent event) {
        float dy = startY - event.getRawY();
        float dx = Math.abs(event.getRawX() - startX);
        float threshold = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                SWIPE_UP_DP, getResources().getDisplayMetrics());
        return dy >= threshold && dx <= dy * SWIPE_MAX_SIDE_RATIO;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 转屏 / 多窗口之后 token 会变，回来再交一次。
        handWindowTokenToOverlay();
        // 面板同理：旧窗口那个 token 已经失效，不重挂的话按钮会变成"点了没反应"。
        getWindow().getDecorView().post(() -> {
            if (controlPanel != null) {
                controlPanel.detach();
                controlPanel.attach();
            }
        });
    }

    /**
     * 把窗口 token 交给叠层，并挂上退出按钮。
     *
     * 必须等 decorView 真的贴上窗口之后才拿得到 token —— 在 onCreate 里直接读会拿到 null，
     * 于是窗口以 PANEL 类型挂上去时立刻被拒（表现是「锁屏上什么都没有，日志也不报错」）。
     */
    private void handWindowTokenToOverlay() {
        final View decorView = getWindow().getDecorView();
        decorView.post(() -> {
            top.izuna.foliamajor.wallpaper.WallpaperOverlay
                    .shared(LockScreenMusicActivity.this)
                    .setLockScreenHost(LockScreenMusicActivity.this);
            addExitButton();
        });
    }

    /**
     * 退出按钮：一个挂在同一个 token 上的小圆钮（TYPE_APPLICATION_PANEL），**左上角**。
     *
     * 为什么不放进 Activity 的内容视图：叠层那层全屏窗口盖在它之上，
     * 画在内容视图里的按钮会被压在下面（看得见摸不着）。
     * 同级的子窗口按添加顺序叠，这一层后加、在最上面；而叠层本身是 NOT_TOUCHABLE，
     * 按在它上面的事件会穿到这一层来，所以按钮照样点得到。
     *
     * 为什么在左上角而不是底部：底部让给了控制条（那里也是系统手势条的地盘，
     * 再挤一个按钮进去容易误触）；左上角是锁屏上唯一一块既不会被歌词内容占住、
     * 又够得着的地方。
     *
     * 用 ✕ 而不是文字：这一层可能出现在任何语言的锁屏上，符号不用翻译。
     */
    private void addExitButton() {
        if (exitButton != null) {
            return;
        }
        float density = getResources().getDisplayMetrics().density;
        TextView button = new TextView(this);
        button.setText("✕");
        button.setTextColor(Color.WHITE);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f);
        button.setGravity(Gravity.CENTER);
        GradientDrawable background = new GradientDrawable();
        background.setShape(GradientDrawable.OVAL);
        background.setColor(0x66000000);
        background.setStroke(Math.max(1, Math.round(density)), 0x66FFFFFF);
        button.setBackground(background);
        int size = Math.round(36f * density);
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                size,
                size,
                WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSLUCENT);
        // 左上角：留一点边距，别贴着屏幕边缘（全面屏的圆角会把它切掉一角），
        // 也避开状态栏那一行的图标。
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = Math.round(18f * density);
        params.y = Math.round(30f * density);
        params.token = getWindow().getDecorView().getWindowToken();
        button.setOnClickListener(view -> dismiss());
        try {
            WindowManager manager = (WindowManager) getSystemService(WINDOW_SERVICE);
            manager.addView(button, params);
            exitButton = button;
        } catch (Throwable error) {
            // token 失效 / ROM 拒绝：至少上滑退出还在，用户不会被锁在外面。
            exitButton = null;
            android.util.Log.w("FoliaLockScreen", "Could not add the exit button", error);
        }
    }

    private void removeExitButton() {
        if (exitButton == null) {
            return;
        }
        try {
            ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(exitButton);
        } catch (Throwable ignored) {
            // 已经被摘掉了。
        }
        exitButton = null;
    }

    @Override
    protected void onDestroy() {
        removeExitButton();
        // 定时刷新必须停：Runnable 持有 Activity，漏掉这一句就是整屏 Activity 泄漏。
        panelHandler.removeCallbacks(panelRefresh);
        if (controlPanel != null) {
            controlPanel.detach();
            controlPanel = null;
        }
        // 回调持有 Activity，不清掉就是整屏泄漏（叠层是进程级单例）。
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .setWindowAttachedListener(null);
        /*
         * 不是我们主动 finish 的 —— 被系统回收了（内存紧张 / 锁屏那个 task 被清）。
         * 记一笔给诊断：用户看到"闪一下就没"时，能分清到底是判退场还是被回收。
         */
        if (!isFinishing()) {
            top.izuna.foliamajor.wallpaper.WallpaperOverlay
                    .shared(this)
                    .noteLockScreenUnexpectedDestroy();
        }
        // 宿主没了，挂在它上面的窗口必须立刻摘掉：PANEL 窗口的 token 失效后
        // 会抛 BadTokenException / 直接被系统移除，而叠层自己还以为它挂着。
        top.izuna.foliamajor.wallpaper.WallpaperOverlay.shared(this).setLockScreenHost(null);
        super.onDestroy();
    }

    /**
     * 用户主动退场。
     *
     * 必须通知叠层一声：不然它下一轮巡检会发现"锁屏页没了、但锁屏条件还成立"，
     * 于是退回悬浮窗那条路再挂一层上来 —— 用户刚关掉的又自己回来了。
     */
    void dismissFromPanel() {
        dismiss();
    }

    private void dismiss() {
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .noteLockScreenDismissedByUser();
        /*
         * 顺手把锁屏解掉（只在它**没有密码**的时候）。
         *
         * 用户点退出要的是"回到桌面"，不是"关掉这一层、然后再自己滑一次" ——
         * 而上滑退出这个手势本身和很多 ROM 的解锁手势同向，用户期待的正是解锁。
         * 有密码 / 指纹的锁屏不能代劳（那需要用户认证，系统会自己弹认证界面），
         * 那种情况只退掉这一层，把锁屏原样还给用户。
         */
        try {
            android.app.KeyguardManager manager =
                    (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            if (manager != null && !manager.isKeyguardSecure()
                    && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                manager.requestDismissKeyguard(this, null);
            }
        } catch (Throwable error) {
            android.util.Log.w("FoliaLockScreen", "Could not dismiss the keyguard", error);
        }
        finish();
    }

    /**
     * 返回键：这个页面是锁屏上的一层，按返回不该"退出应用"，也不该留在这里挡着。
     */
    @Override
    public void onBackPressed() {
        dismiss();
    }
}
