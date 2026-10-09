package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.opengl.GLUtils;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * 歌词壁纸的 OpenGL ES 2.0 渲染器。
 *
 * 三件事叠在一起构成画面：
 * 1. 背景：随时间缓慢流动的双色光晕 + 上浮的细颗粒 + 暗角（全部在片元着色器里算）；
 * 2. 封面：换歌时从 JS 送来的封面缩到 24px 再放大，得到一张近似高斯模糊的底图；
 * 3. 歌词：每行栅格化成一张纹理，当前行按进度做「逐字点亮」的擦除高亮，
 *    上下行按距离缩小淡出，换行的位移用插值过渡，不做跳变。
 *
 * 之所以不用 WebGL/Pixi：动态壁纸只能往系统给的 Surface 上画，塞不进 WebView。
 */
public final class LyricsRenderer implements GLSurfaceView.Renderer {

    private final Context context;

    public LyricsRenderer(Context context) {
        this.context = context == null ? null : context.getApplicationContext();
    }

    /**
     * 一种可视化风格在壁纸上的落地参数。
     *
     * App 里的十几种可视化是 PixiJS 场景，逐帧照搬到壁纸上做不到（壁纸只能画原生 Surface）。
     * 这里退一步做「风格对齐」：每种模式抽出一小组观感参数，背景的流速、光团、颗粒、
     * 歌词的行距与高亮方式各不相同，选中什么模式，壁纸就呈现那种气质。
     */
    private static final class Style {
        final float flowSpeed;
        final float blobScale;
        final float dust;
        final float glow;
        final float lineSpacing;
        final float falloff;
        final float currentScale;
        /**
         * 0 = 逐字擦除高亮（按行内进度在纹理上横向扫过去），
         * 1 = 整行渐变（整行从一开始就铺满主题渐变，进度只把整行的亮度往上推，不擦除），
         * 2 = 不做高亮，
         * 3 = **逐字上浮**（每个字按自己的小进度依次浮起来并点亮渐变，见 CHAR_SPAN/CHAR_RISE）。
         */
        final int textEffect;
        /**
         * 跟唱上浮：当前行在唱的过程中**整行一起**往上抬多少（单位 = 行距）。
         * 逐字上浮（textEffect = 3）时给 0 —— 那时动的是每个字，整行再抬一次就是双重位移。
         */
        final float progressLift;

        Style(float flowSpeed, float blobScale, float dust, float glow, float lineSpacing,
              float falloff, float currentScale, int textEffect, float progressLift) {
            this.flowSpeed = flowSpeed;
            this.blobScale = blobScale;
            this.dust = dust;
            this.glow = glow;
            this.lineSpacing = lineSpacing;
            this.falloff = falloff;
            this.currentScale = currentScale;
            this.textEffect = textEffect;
            this.progressLift = progressLift;
        }
    }

    /*
     * **歌词动画只有这一套，不再按播放页选的可视化模式分风格。**
     *
     * 原来这里是一张按模式取名的大表（商籁/莫奈/流光…各一套参数）。用户明确要求
     * 「不要按所选模式，就保持只有一个样式」：模式每换一次，壁纸的歌词动效就跟着换一副
     * 样子 —— 而在别处调好的参数（比如渐变）在另一种模式下根本不生效，
     * 看上去就像"改了又没了"。统一成一套之后，怎么切模式，壁纸都是同一个样子。
     *
     * 这一套只保留用户点名要的三样：
     *   1. **渐变进度**：`textEffect = 3`，**逐字上浮**。整行只有一张纹理，
     *      按字切 UV 分别画（`drawPerChar`）：第 i 个字在自己的小时间窗里
     *      （窗宽 CHAR_SPAN × 行长，依次错开）浮起来（CHAR_RISE × 行距）
     *      并从暗白过渡到整行连续的主题渐变 —— 唱到哪个字，哪个字浮起来。
     *      （0 = 逐字擦除，1 = 整行一起推亮度，2 = 不做高亮。）
     *   2. **边缘行进出场**（列表的进出，不是卷轴的滚动）：最外侧那一行把
     *      `|距离| ∈ [VISIBLE_SPAN-1, VISIBLE_SPAN]` **整整一行**的距离当作自己的动画
     *      全程 —— 唱过去的**向上加速飞出屏幕外**（EXIT_FLY，按 edgeT² 加速，同时缩一点、
     *      淡到 0），还没唱到的**从下方滑进来**（ENTER_RISE）。
     *      亮度衰减只算到 FALLOFF_MAX_DISTANCE 行，不然轮到它做动画时已经暗得看不见。
     *   3. **一点点动画**：背景几乎不流动（flowSpeed 0.25）、无颗粒（dust 0）、
     *      光晕很弱（glow 0.75）—— 开销和分心都压到最低，动的只是歌词本身。
     *
     * 另外：原生这一层不再画任何线条背景。原先商籁那套装饰（外框 + 四角标、焦点行上下
     * 的引导线、三圈呼吸细框）全部移除 —— 用户明确要求「有线条背景去掉」。
     * 线条的开关（showFixedGeo / showGuide / outerFrameMode）从此只作用于叠层那一层。
     *
     * 注意这只影响**原生这一层**（WallpaperService 的 GLES 歌词）。叠层那层 WebView
     * 跑的是播放页同一套可视化，照旧跟随所选模式 —— 两边互不影响。
     */
    private static final Style LYRICS_STYLE =
            new Style(0.25f, 0.80f, 0.0f, 0.75f, 0.125f, 0.24f, 1.00f, 3, 0.0f);

    /** 模式参数保留在签名里（调用方照旧传当前模式），但已经不再参与取值。 */
    private static Style styleFor(String mode) {
        return LYRICS_STYLE;
    }

    private static final String TAG = "LyricsRenderer";
    /**
     * 待机（没有歌）时的配色。底色调亮一档、高亮给足饱和的紫，
     * 这样只有背景在跑的时候画面是有内容的，而不是一块黑。
     */
    private static final int IDLE_BASE = 0xFF16162A;
    private static final int IDLE_ACCENT = 0xFF8A6BFF;
    /** 一次最多画这么多行（当前行各向上下展开）。 */
    private static final int VISIBLE_SPAN = 3;
    private static final int TEXTURE_CACHE_LIMIT = 24;
    /** 翻译行相对主行的字号比例。 */
    private static final float TRANSLATION_FONT_RATIO = 0.62f;
    /**
     * 一行文本栅格化后的高度 ≈ 字号 × 这个系数（见 textureFor：行高 + 上下各 0.25 字号的留白）。
     * 算双行行距时用它，免得相邻两句叠在一起。
     */
    private static final float TEXTURE_HEIGHT_FACTOR = 1.62f;
    /** 换行走入的时长（秒）。短一点才叫「一点点动画」——长了就变成拖尾。 */
    private static final float LINE_ENTER_SECONDS = 0.42f;
    /** 走入时从下方多远滑上来（单位 = 行距）。 */
    private static final float LINE_ENTER_RISE = 0.16f;
    /** 焦点行极缓的呼吸幅度（亮度 / 缩放）。只是让字不像贴图，幅度必须很小。 */
    private static final float LINE_BREATH = 0.05f;
    /** 逐字上浮：单个字浮起来的时长占整行时长的比例，剩下的时间用来把字依次错开。 */
    private static final float CHAR_SPAN = 0.45f;
    /** 逐字上浮：一个字浮起多高（单位 = 行距）。 */
    private static final float CHAR_RISE = 0.18f;
    /**
     * 边缘行「飞出屏幕外」：向上额外走多远（单位 = 行距）。
     *
     * 数值必须够大：最外侧那行原本就在屏幕上方 22% 处，走不到一个整屏高度的一半
     * 就谈不上"飞出去"—— 用户看到就只是"淡淡地没了"。3.6 个行距 ≈ 半屏，
     * 配合下面的位移曲线，在还看得见（alpha ≈ 0.3）的时候就已经飞出屏幕外了。
     */
    private static final float EXIT_FLY = 3.60f;
    /** 边缘行「出现」：从屏幕下方多远滑进来（单位 = 行距）。 */
    private static final float ENTER_RISE = 1.10f;
    /** 边缘行飞出时额外缩多少（1 = 原大小）。 */
    private static final float EXIT_SHRINK = 0.12f;
    /**
     * 亮度衰减最多算到这么远（单位 = 行）。再往外就不再继续压暗 ——
     * 否则最外侧那行轮到它做飞出/出现动画时已经暗得看不见了。
     */
    private static final float FALLOFF_MAX_DISTANCE = 2f;

    private int surfaceWidth = 1;
    private int surfaceHeight = 1;
    /** 壁纸横向偏移（桌面左右滑页时系统会回调），用来让背景跟着轻微视差。 */
    private volatile float offsetX = 0f;
    /** 已上传的封面对应的 base64。壁纸可能比应用晚启动，所以只能靠比对来发现新封面。 */
    private String loadedCoverKey = null;

    private int backgroundProgram = 0;
    private int quadProgram = 0;
    private int quadBuffer = 0;

    private float[] accent = new float[] { 0.49f, 0.36f, 1.0f };
    private float[] accentTarget = new float[] { 0.49f, 0.36f, 1.0f };
    /** 与 App 当前主题一致的底色与动效强度。 */
    private float[] base = new float[] { 0.035f, 0.035f, 0.043f };
    private float[] baseTarget = new float[] { 0.035f, 0.035f, 0.043f };
    private float motion = 1f;
    private float motionTarget = 1f;
    /** 背景模糊强度 0..1。 */
    private float blurAmount = WallpaperLyricsState.DEFAULT_BLUR;
    /**
     * 歌词高亮的两个渐变端点色，取自**当前主题**。
     *
     * 早先是从封面按色相分桶取主色：想法不错，但封面主色常常偏暗偏灰，提亮之后
     * 仍然和界面上的配色不搭 —— 壁纸和 App 用两套色，看着就不像一个应用。
     * 现在直接跟着主题走，主题换了端点色就换。
     */
    private float[] coverTint = new float[] { 1f, 1f, 1f };
    private float[] coverTintTarget = new float[] { 1f, 1f, 1f };
    private float[] coverTint2 = new float[] { 1f, 1f, 1f };
    private float[] coverTint2Target = new float[] { 1f, 1f, 1f };
    /** 1×1 白色纹理：轨道、进度条这类纯色矩形要用它（着色器总要绑一张纹理）。 */
    private int solidTexture = 0;

    private float animatedIndex = 0f;
    private float animatedProgress = 0f;
    /**
     * 换行走入：新的一句成为焦点时的滑入进度 0..1（1 = 已经站定）。
     * 这是原生层唯一「额外」的动画 —— 去掉线条背景之后画面太静，加这一点点就够。
     */
    private float lineEnter = 1f;
    private int lastComputedIndex = -1;
    private long lastNanos = 0L;
    private float elapsedSeconds = 0f;

    private int coverTexture = 0;
    /** 上图时记下位图尺寸，铺满时按它算 cover 比例，别把图拉变形。 */
    private int coverWidth = 0;
    private int coverHeight = 0;
    /** 自选背景图。与封面分开存，换歌时不该被顶掉。 */
    private int imageTexture = 0;
    private int imageWidth = 0;
    private int imageHeight = 0;
    private String loadedImageKey = null;
    private Style style = LYRICS_STYLE;
    /** 歌词动画实验台里当前生效那个模式的配置（扁平键值表，见 WallpaperLyricsState.tuning）。 */
    private java.util.Map<String, Float> tuning = java.util.Collections.emptyMap();
    /** 当前模式字面量。有些开关只有某个模式才有，得按模式决定要不要读默认值。 */
    private String activeMode = "sonnet";
    /** 当前歌词字体；null 表示还没有从磁盘读过或上次读出来是坏文件。 */
    private String loadedFontKey = null;
    private Typeface activeTypeface = null;

    /** 封面纹理只在 mode=cover 时需要；切到别的模式就释放掉。 */
    private void releaseCover() {
        if (coverTexture != 0) {
            GLES20.glDeleteTextures(1, new int[] { coverTexture }, 0);
            coverTexture = 0;
        }
    }

    private void releaseImage() {
        if (imageTexture != 0) {
            GLES20.glDeleteTextures(1, new int[] { imageTexture }, 0);
            imageTexture = 0;
        }
    }

    /** key = 文本 + '@' + 字号，value = 已上传的纹理。插入顺序即淘汰顺序。 */
    private final Map<String, TextTexture> textures =
            new LinkedHashMap<String, TextTexture>(TEXTURE_CACHE_LIMIT, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, TextTexture> eldest) {
                    if (size() <= TEXTURE_CACHE_LIMIT) {
                        return false;
                    }
                    eldest.getValue().dispose();
                    return true;
                }
            };

    void setOffsets(float xOffset) {
        this.offsetX = xOffset;
    }


    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        backgroundProgram = buildProgram(BACKGROUND_VERTEX, BACKGROUND_FRAGMENT);
        quadProgram = buildProgram(QUAD_VERTEX, QUAD_FRAGMENT);
        quadBuffer = createUnitQuad();
        solidTexture = createSolidTexture();
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glEnable(GLES20.GL_BLEND);
        // 位图纹理是预乘 alpha 的（Android Bitmap 的存储格式如此），
        // 因此用 ONE 而不是 SRC_ALPHA，否则字的边缘会被二次相乘、发灰。
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        surfaceWidth = Math.max(1, width);
        surfaceHeight = Math.max(1, height);
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight);
        textures.clear();
    }

    /** 两帧之间最少隔多久（纳秒）：30fps。 */
    private static final long FRAME_INTERVAL_NS = 33_000_000L;
    private long lastFrameNanos = 0L;

    /** 把渲染节奏按到 30fps；见 onDrawFrame 里的说明。 */
    private void throttleFrameRate() {
        if (lastFrameNanos == 0L) {
            lastFrameNanos = System.nanoTime();
            return;
        }
        long target = lastFrameNanos + FRAME_INTERVAL_NS;
        long now = System.nanoTime();
        if (now >= target) {
            lastFrameNanos = now;
            return;
        }
        long remainingMillis = (target - now) / 1_000_000L;
        if (remainingMillis <= 0L) {
            lastFrameNanos = now;
            return;
        }
        try {
            Thread.sleep(remainingMillis, (int) ((target - now) % 1_000_000L));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        lastFrameNanos = System.nanoTime();
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        /*
         * 帧率上限 30fps。
         *
         * 壁纸是**一直在跑**的东西（桌面停留时间远长于播放页），60fps 画一屏
         * 渐变 + 几行字纯属浪费：实测它和应用前台的可视化抢的是同一份 GPU/CPU，
         * 叠层（WebView 里那套 Pixi）再叠上来，低端机上会把主线程拖到解码音频都跟不上
         * —— 用户听到的就是"音频撕裂"。30fps 对"背景 + 歌词"这个内容量完全够看。
         *
         * 用 sleep 对齐而不是直接 return：直接 return 的话 EGLSwapBuffers 仍然会执行，
         * 交换出去的是上一帧没画完的缓冲，会有撕裂感。让 GL 线程睡到下一帧的时间点，
         * 摆出去的每一帧都是画完整的。
         */
        throttleFrameRate();
        long now = System.nanoTime();
        float deltaSeconds = lastNanos == 0L ? 0.016f : Math.min(0.1f, (now - lastNanos) / 1e9f);
        lastNanos = now;
        elapsedSeconds += deltaSeconds;

        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();

        // 当前行由原生按墙钟从时间轴算出来，不依赖 JS 推送 ——
        // 应用退到后台后 WebView 的定时器会被挂起，靠 JS 推「当前行」歌词就走不动了。
        long position = snapshot.positionMs();
        int computedIndex = snapshot.indexAt(position);
        float computedProgress = snapshot.progressAt(position);

        if (snapshot.isEmpty()) {
            return;
        }
        activeMode = snapshot.visualizerMode;
        // style / tuning 必须在这之前落地：下面的行插值要看 enableTransitions，
        // 后面的背景与歌词绘制也要看这两个。
        style = styleFor(activeMode);
        tuning = WallpaperLyricsState.tuning();

        /*
         * **行内进度在换行那一瞬必须直接对齐，不能插值。**
         *
         * 换行时 computedProgress 是从 1 跳回 0 的（新行从头唱），而 animatedIndex 还要
         * 花几百毫秒才滑到新行 —— 这段重叠期里「上一行」仍然是焦点行。若进度也跟着
         * 平滑回落，上一行已经浮起来的字就会被一路拉回原位（**突然下浮**），
         * 等新行接手再从原位浮起来（**然后再上浮**）。用户报的就是这一下。
         * 所以：同一行内正常平滑，换行这一刻直接对齐。
         */
        boolean lineChanged = lastComputedIndex >= 0 && computedIndex != lastComputedIndex;
        if (lineChanged) {
            animatedProgress = computedProgress;
        } else {
            animatedProgress = approach(animatedProgress, computedProgress, deltaSeconds, 6f);
        }
        float targetIndex = computedIndex;
        // enableTransitions 关掉时（以及换歌、拖动进度条这类大跳）直接对齐，不要缓慢地滑过去。
        if (!tb("enableTransitions", true) || Math.abs(targetIndex - animatedIndex) > 2.5f) {
            animatedIndex = targetIndex;
            animatedProgress = computedProgress;
            // 大跳不做走入动画：拖进度条时一堆行排队滑进来会像抽搐。
            lineEnter = 1f;
        } else {
            animatedIndex = approach(animatedIndex, targetIndex, deltaSeconds, 7f);
            // 焦点换到新的一句：重新走一次滑入。
            if (lineChanged) {
                lineEnter = 0f;
            }
        }
        lastComputedIndex = computedIndex;
        lineEnter = Math.min(1f, lineEnter + deltaSeconds / LINE_ENTER_SECONDS);

        // 没歌（冷启动、纯待机）时别用那套「近乎全黑」的默认底色：
        // 空状态下背景只有一层极暗的底 + 很弱的光团，看上去就是一块黑屏。
        // 这里换一套能站得住的待机配色，让它至少像一张壁纸。
        boolean idle = snapshot.isEmpty();
        accentTarget = rgbFromColor(idle ? IDLE_ACCENT : snapshot.accent);
        baseTarget = rgbFromColor(idle ? IDLE_BASE : snapshot.baseColor);
        motionTarget = idle ? Math.max(0.6f, snapshot.motion) : snapshot.motion;
        // 模糊强度改了要重新栅格化底图，所以单独比对：直接每帧重算的话一张 512 的位图
        // 每帧缩放两遍，代价太大。
        if (Math.abs(snapshot.blur - blurAmount) > 0.01f) {
            blurAmount = snapshot.blur;
            loadedCoverKey = null;
            loadedImageKey = null;
        }
        float blend = Math.min(1f, deltaSeconds * 3f);
        for (int i = 0; i < 3; i++) {
            accent[i] += (accentTarget[i] - accent[i]) * blend;
            base[i] += (baseTarget[i] - base[i]) * blend;
            coverTint[i] += (coverTintTarget[i] - coverTint[i]) * blend;
            coverTint2[i] += (coverTint2Target[i] - coverTint2[i]) * blend;
        }
        motion += (motionTarget - motion) * blend;

        // 端点色只跟主题走：主题色本身可能由封面推导而来，但那是主题自己的事，
        // 壁纸这边不再单独去看封面 —— 两套取色逻辑只会画出两套对不上的颜色。
        float[][] themeTints = tintsFromTheme(accentTarget);
        coverTintTarget = rgbOfHsv(themeTints[0]);
        coverTint2Target = rgbOfHsv(themeTints[1]);

        boolean useCover = "cover".equals(snapshot.backgroundMode);
        boolean useImage = "image".equals(snapshot.backgroundMode);
        syncCover(useCover ? snapshot.cover : null);
        syncImage(useImage ? snapshot.image : null);
        syncFont(snapshot.font);

        GLES20.glClearColor(0.02f, 0.02f, 0.03f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);

        // 选了图就只画「图 + 歌词」：用户要的就是那张图本身，
        // 再叠一层流动光晕和模糊封面反而把图盖掉了。图没就绪（读盘要一帧）时才走原来的渐变。
        boolean imageReady = useImage && imageTexture != 0;
        if (imageReady) {
            drawImage();
        } else {
            drawBackground();
            if (useCover) {
                drawCover();
            }
        }
        // 「跟随 + 叠层」时原生这层可以不画歌词/进度条：
        // 叠层跑的是播放页同一套可视化，自己也画歌词，两层叠在一起会重影。
        // 用 wp. 前缀的那两个开关控制，缺省照旧（画）。
        if (!tb("wp.hideNativeProgress", false)) {
            drawProgressBar(snapshot);
        }
        if (!tb("wp.hideNativeLyrics", false)) {
            drawLyrics(snapshot);
        }
    }

    /**
     * 歌词上方那条整首歌的进度条。
     *
     * 位置取屏幕高度的 8%：上半部是状态栏与时钟的地盘，再往上会被系统 UI 压住；
     * 歌词块以 47% 为中心、行距约 11%，最上面一行大致在 12% 处，所以 8% 正好落在
     * 「歌词顶部再往上一点点」的空白处。
     *
     * 没给时长（直播 / 拿不到 duration）就整条不画，而不是画一条永远为 0 的条。
     */
    private void drawProgressBar(WallpaperLyricsState.Snapshot snapshot) {
        if (!snapshot.showProgress || snapshot.durationMs <= 0L || solidTexture == 0) {
            return;
        }
        float ratio = clamp(snapshot.positionMs() / (float) snapshot.durationMs, 0f, 1f);
        float width = surfaceWidth * 0.62f;
        float left = (surfaceWidth - width) * 0.5f;
        float height = Math.max(2f, surfaceHeight * 0.0045f);
        float top = surfaceHeight * 0.082f;

        // 轨道：一层很淡的白，深色与浅色底图上都看得出边界。
        drawTexturedQuad(solidTexture, left, top, width, height, 1f, 1f, 1f, 0.15f, -1f, 0f, 1f);
        if (ratio <= 0f) {
            return;
        }
        // 已播放的那段沿长度方向在封面两色之间渐变。GLES2 里做渐变最省事的办法就是
        // 分段画：段与段之间多叠半像素，避免接缝处露出轨道的暗线。
        float filled = width * ratio;
        int segments = 10;
        float segment = filled / segments;
        for (int i = 0; i < segments; i++) {
            float t = segments > 1 ? i / (float) (segments - 1) : 1f;
            float r = coverTint[0] + (coverTint2[0] - coverTint[0]) * t;
            float g = coverTint[1] + (coverTint2[1] - coverTint[1]) * t;
            float b = coverTint[2] + (coverTint2[2] - coverTint[2]) * t;
            drawTexturedQuad(solidTexture, left + i * segment, top,
                    segment + 0.6f, height, r, g, b, 0.92f, -1f, 0f, 1f);
        }
    }

    // ---- 背景 ----

    private void drawBackground() {
        if (backgroundProgram == 0) {
            return;
        }
        GLES20.glUseProgram(backgroundProgram);
        GLES20.glDisable(GLES20.GL_BLEND);

        int position = GLES20.glGetAttribLocation(backgroundProgram, "aPosition");
        int uv = GLES20.glGetAttribLocation(backgroundProgram, "aUv");
        bindQuad(position, uv);

        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uTime"), elapsedSeconds);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uAspect"),
                surfaceWidth / (float) surfaceHeight);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uOffsetX"), offsetX);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(backgroundProgram, "uAccent"),
                accent[0], accent[1], accent[2]);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(backgroundProgram, "uBase"),
                base[0], base[1], base[2]);
        // ---- 实验台配置（当前模式那一份）----
        // cameraIntensity：播放页里控制相机推拉强度，壁纸上等价的是背景整体的流动幅度。
        float cameraIntensity = Math.max(0f, tf("cameraIntensity", 1f));
        // mgDensity：背景「mg」层（光团）的密度。
        float mgDensity = tf("mgDensity", 1f);
        boolean showOnlyText = tb("showOnlyText", false);
        boolean showBackgroundMg = tb("showBackgroundMg", true);
        boolean showBackgroundDecor = tb("showBackgroundDecor", true);
        boolean postProcessEnabled = tb("postProcessEnabled", false);
        // 应用侧「视觉设置」里的背景开关，壁纸上改成它的原生对应物。
        // 字段名带 wp. 前缀：它们不属于某个模式的 tuning，而是全局设置，
        // 跟 per-mode 字段混在同一张表里靠前缀区分。
        float backgroundOpacity = clamp(tf("wp.backgroundOpacity", 1f), 0f, 1f);
        boolean vignetteDisabled = tb("wp.vignetteDisabled", false);
        boolean geometricDisabled = tb("wp.geometricDisabled", false);

        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uMotion"),
                motion * style.flowSpeed * cameraIntensity);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uBlob"),
                showOnlyText || !showBackgroundMg ? 0f : style.blobScale * mgDensity);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uDust"),
                showOnlyText || !showBackgroundDecor ? 0f : style.dust);
        // 背景不透明度：应用里那个滑杆直接压在壁纸背景层的强度上。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uGlow"),
                (showOnlyText ? 0f : style.glow) * backgroundOpacity);
        // 后处理默认走 base 行为（暗角系数 0.85、无颗粒、无对比度增强），
        // 只有实验台把总开关打开时才追加实验台里的数值。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpGrain"),
                postProcessEnabled ? clamp(tf("postProcessGrain", 0f), 0f, 1f) : 0f);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpContrast"),
                postProcessEnabled ? clamp(tf("postProcessContrast", 0f), -0.9f, 1f) : 0f);
        // 关掉暗角 = 不压边缘（0 = 完全不压暗，见着色器里 mix(0.52, 1.0, vig) 的等价写法）。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpVignette"),
                vignetteDisabled ? -1f
                        : postProcessEnabled ? clamp(tf("postProcessVignette", 0.85f), 0f, 2f)
                        : 0.85f);
        GLES20.glUniform4f(GLES20.glGetUniformLocation(backgroundProgram, "uRect"),
                -1f, -1f, 2f, 2f);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        unbindQuad(position, uv);
        GLES20.glEnable(GLES20.GL_BLEND);
    }

    /**
     * 按 cover 方式铺满：长边对齐、短边裁掉，保持图片自身比例。
     * 直接拉成屏幕尺寸的话，竖图会被压扁、横图会被拉长 —— 这是「拉伸」的来源。
     */
    private void drawCoverFitted(int texture, int bitmapWidth, int bitmapHeight, float alpha) {
        if (texture == 0 || quadProgram == 0 || bitmapWidth <= 0 || bitmapHeight <= 0) {
            return;
        }
        float scale = Math.max(surfaceWidth / (float) bitmapWidth,
                surfaceHeight / (float) bitmapHeight);
        float width = bitmapWidth * scale;
        float height = bitmapHeight * scale;
        float left = (surfaceWidth - width) * 0.5f;
        float top = (surfaceHeight - height) * 0.5f;
        drawTexturedQuad(texture, left, top, width, height,
                1f, 1f, 1f, alpha, -1f, 1f, 1f);
    }

    private void drawCover() {
        // 封面那层的浓淡跟着应用侧的背景不透明度走，两边观感才一致。
        float opacity = clamp(tf("wp.backgroundOpacity", 1f), 0f, 1f);
        drawCoverFitted(coverTexture, coverWidth, coverHeight, 0.28f * opacity);
    }

    /** 自选背景图铺满，再压一层薄薄的暗色蒙版保证歌词可读。 */
    private void drawImage() {
        if (imageTexture == 0 || quadProgram == 0) {
            return;
        }
        drawCoverFitted(imageTexture, imageWidth, imageHeight, 1f);
        // 蒙版铺满整屏：uUseTexColor=0 时着色器只用 uColor，纹理内容不参与。
        drawTexturedQuad(imageTexture, 0f, 0f, surfaceWidth, surfaceHeight,
                0f, 0f, 0f, 0.22f, -1f, 0f, 1f);
    }

    /**
     * 自选图从私有文件里读，不从内存里的 base64 解 —— 这样壁纸服务不管什么时候被系统拉起、
     * 应用进程被回收过几次，只要那张图还在磁盘上就能画出来。
     */
    private void syncImage(String imageKey) {
        if (imageKey == null) {
            // 没选图（或用户刚清除）时必须把纹理放掉：只 return 的话上一张图会一直挂在画面上。
            if (loadedImageKey != null) {
                loadedImageKey = null;
                releaseImage();
            }
            return;
        }
        if (imageKey.equals(loadedImageKey)) {
            return;
        }
        loadedImageKey = imageKey;
        Bitmap decoded = WallpaperBackgroundImage.load(context);
        if (decoded == null) {
            return;
        }
        if (imageTexture != 0) {
            GLES20.glDeleteTextures(1, new int[] { imageTexture }, 0);
            imageTexture = 0;
        }
        // 自选图同样吃模糊滑杆：有人就是想要那张图「糊一点」当底色。
        // 2560 的图缩到 12px 再放大回去代价不小，所以先压到 1600 再处理。
        Bitmap source = decoded;
        int edge = Math.max(decoded.getWidth(), decoded.getHeight());
        if (blurAmount > 0.02f && edge > 1600) {
            float ratio = 1600f / edge;
            source = Bitmap.createScaledBitmap(decoded,
                    Math.max(1, Math.round(decoded.getWidth() * ratio)),
                    Math.max(1, Math.round(decoded.getHeight() * ratio)), true);
            decoded.recycle();
        }
        Bitmap blurred = blurredCover(source, blurAmount);
        if (blurred != source) {
            source.recycle();
        }
        imageTexture = upload(blurred);
        imageWidth = blurred.getWidth();
        imageHeight = blurred.getHeight();
        blurred.recycle();
    }

    // ---- 歌词 ----

    private void drawLyrics(WallpaperLyricsState.Snapshot snapshot) {
        if (quadProgram == 0) {
            return;
        }
        if (snapshot.isEmpty()) {
            return;
        }

        // 双行：整条时间轴里得真有翻译才开。全是单语歌时不会因为开关而多留出空位。
        boolean dualLine = snapshot.showTranslation && snapshot.hasTranslation;

        float baseFontPx = clamp(surfaceHeight * 0.062f, 26f, 84f);
        float subFontPx = Math.round(baseFontPx * TRANSLATION_FONT_RATIO);
        float lineStep = surfaceHeight * style.lineSpacing;
        if (dualLine) {
            // 行距必须装得下「主行 + 翻译行」，否则相邻两句会叠在一起。
            lineStep = Math.max(lineStep, (baseFontPx + subFontPx) * TEXTURE_HEIGHT_FACTOR);
        }
        // 双行时整块视觉重心下移了半行翻译，焦点位置跟着上抬一点。
        float centerY = surfaceHeight * (dualLine ? 0.44f : 0.47f);
        float maxWidth = surfaceWidth * 0.84f;
        // 垫在歌词后面的背景字（不带任何线条 —— 线条装饰已经整块移除）。
        drawBackdropText(snapshot, centerY, lineStep);

        int first = Math.max(0, (int) Math.floor(animatedIndex) - VISIBLE_SPAN);
        int last = Math.min(snapshot.lines.length - 1,
                (int) Math.ceil(animatedIndex) + VISIBLE_SPAN);

        for (int i = first; i <= last; i++) {
            String text = snapshot.lines[i].text;
            if (text == null || text.trim().isEmpty()) {
                continue;
            }
            float signed = i - animatedIndex;
            float distance = Math.abs(signed);
            // 槽位是离散的：最外侧那一行把 [VISIBLE_SPAN-1, VISIBLE_SPAN] 这一整行的
            // 距离当作自己的动画全程，走完就被裁掉（此刻 alpha 已经是 0，看不出裁剪）。
            if (distance > VISIBLE_SPAN + 0.02f) {
                continue;
            }
            /*
             * 边缘行的进出场动画 —— 这是**列表**的进出，不是卷轴的滚动：
             *   最上面那行（唱过去的）：向上**加速飞出屏幕外**（EXIT_FLY，按 edgeT² 加速）
             *     并淡到 0、缩一点，像被丢出去；
             *   最下面那行（还没唱到的）：从下方 ENTER_RISE 个行距处**滑进来**并淡入。
             * 过渡带占**整整一行**的距离（以前只给半行，动画还没展开就没了，等于没有）。
             * 拖进度条倒着走时这两段是对称的，不会出现凭空冒出来的行。
             */
            float edgeT = clamp(distance - (VISIBLE_SPAN - 1f), 0f, 1f);
            float edgeShift = 0f;
            float edgeAlpha = 1f;
            float edgeScale = 1f;
            if (edgeT > 0f) {
                // 位移轻微加速（起步慢一点、越飞越快），但**不是**纯 t² ——
                // 纯 t² 的话前半程几乎不动，等它动起来 alpha 已经淡没了。
                float travel = edgeT * (0.35f + 0.65f * edgeT);
                // 出场那侧走 EXIT_FLY（半屏，真的飞出屏幕外）；
                // 入场那侧走 ENTER_RISE（从屏幕下沿外一点滑进来，不需要那么远）。
                edgeShift = signed < 0f
                        ? -lineStep * EXIT_FLY * travel
                        : lineStep * ENTER_RISE * travel;
                edgeScale = 1f - EXIT_SHRINK * edgeT;
                // 淡出集中在后半程（1 - t²）：先让它飞，飞出去了再淡掉。
                // 用 1 - t 的话它还没飞出去就已经看不见了 —— 等于没有动画。
                edgeAlpha = 1f - edgeT * edgeT;
            }

            TextTexture texture = textureFor(text, Math.round(baseFontPx));
            if (texture == null) {
                continue;
            }

            float scale = 1f - Math.min(0.34f, 0.13f * distance);
            // typographyMotion：播放页里控制排版自身的呼吸/浮动。
            // 注意它的默认值是 1（= 播放页的正常强度），不是 0 —— 所以这里的幅度必须做得很小，
            // 否则每个没动过这条设置的人都会看到歌词在上下漂。
            float typographyMotion = Math.max(0f, tf("typographyMotion", 0f));
            float bob = 0f;
            if (distance < 0.5f) {
                scale *= style.currentScale;
                if (typographyMotion > 0.001f) {
                    scale *= 1f + 0.010f * (float) Math.sin(elapsedSeconds * 1.7f) * typographyMotion;
                    bob = (float) Math.sin(elapsedSeconds * 1.15f)
                            * lineStep * 0.012f * typographyMotion;
                }
            }
            float width = texture.width * scale * edgeScale;
            float height = texture.height * scale * edgeScale;
            if (width > maxWidth) {
                float fit = maxWidth / width;
                width *= fit;
                height *= fit;
            }
            // 亮度衰减最多算到 FALLOFF_MAX_DISTANCE 行：再往外还继续压暗的话，
            // 最外侧那行轮到它做飞出/出现动画时已经暗得看不见了 —— 等于没有动画。
            float alpha = clamp(1f - style.falloff * Math.min(distance, FALLOFF_MAX_DISTANCE),
                    0f, 1f) * edgeAlpha;
            boolean isCurrent = distance < 0.5f;
            /*
             * **每一行有自己的进度**，不是全场共用一个值：
             *   唱过的行 = 1（字全部浮起，并保持这个状态），
             *   正在唱的行 = 行内进度（逐字浮起），
             *   还没唱到的行 = 0（停在原位，等着浮）。
             * 共用一个值的话，换行时旧行会被新行的 0 拉回去 —— 就是「突然下浮」。
             */
            boolean isSinging = i == lastComputedIndex;
            float rowProgress = i < lastComputedIndex ? 1f : (isSinging ? clamp(animatedProgress, 0f, 1f) : 0f);
            // 换行走入：新的一句从下方 LINE_ENTER_RISE 个行距处滑上来并淡入。
            // 缓出曲线 —— 快进慢收，落位那一下才不会「顿」。
            float enter = isCurrent ? easeOutCubic(clamp(lineEnter, 0f, 1f)) : 1f;
            alpha *= clamp(1f - LINE_ENTER_RISE * 2.6f * (1f - enter), 0f, 1f);
            // 整行渐变：起手就抬到一半亮度，剩下的由行内进度推满。
            // 不做「从 0 开始」——那会让整行在行首那一瞬几乎看不见。
            if (style.textEffect == 1 && isSinging) {
                alpha *= clamp(0.62f + 0.38f * rowProgress, 0f, 1f);
            }
            if (isCurrent) {
                // 极缓的呼吸：亮度 ±5%、大小 ±0.6%。周期故意开得很长（约 4 秒一轮），
                // 扫一眼看不出在动，但盯久了字不像贴上去的。
                // 注意：width/height 在这之前已经按 scale 算完了，所以这里直接改尺寸。
                float breath = (float) Math.sin(elapsedSeconds * 1.55f);
                alpha *= 1f - LINE_BREATH * 0.5f + LINE_BREATH * 0.5f * breath;
                float breathScale = 1f + 0.006f * breath;
                width *= breathScale;
                height *= breathScale;
            }
            // 跟唱上浮：整行一起抬多少（逐字上浮时 progressLift = 0，动的是每个字）。
            float lift = isCurrent
                    ? -lineStep * style.progressLift * rowProgress
                            + lineStep * LINE_ENTER_RISE * (1f - enter)
                    : 0f;
            /*
             * **浮起状态要跨行连续**：唱过的行整行保持浮起（= 行末逐字浮完的那个位移），
             * 还没唱到的行停在原位等着浮。唱完 → 让位 → 新行接手，全程没有位移往回走。
             * 判定用行号而不是 signed：换行那几百毫秒里 animatedIndex 还在上一行附近，
             * 用 signed 会把「正在唱的新行」错判成已唱完的行。
             */
            float charLift = isSinging ? 0f : (i < lastComputedIndex ? -lineStep * CHAR_RISE : 0f);
            float y = centerY + signed * lineStep + bob + lift + charLift + edgeShift;
            // textEffect=0 传行内进度（横向擦到第几个字）；=1 传整行亮度；
            // =2 不做高亮，传 -1 走纯色分支；=3 逐字上浮由 drawPerChar 自己算每个字的进度。
            float progress = (isSinging && style.textEffect <= 1) ? rowProgress : -1f;

            if (isSinging && style.textEffect == 3) {
                drawPerChar(texture, y, width, height, alpha, rowProgress, lineStep);
            } else {
                drawCentered(texture, y, width, height, alpha, progress, style.textEffect == 1);
            }

            if (!dualLine) {
                continue;
            }
            String translation = snapshot.lines[i].translation;
            if (translation == null || translation.trim().isEmpty()) {
                // 这一行没翻译：不画、也不留空位。
                continue;
            }
            TextTexture subTexture = textureFor(translation, Math.round(subFontPx));
            if (subTexture == null) {
                continue;
            }
            float subWidth = subTexture.width * scale;
            float subHeight = subTexture.height * scale;
            if (subWidth > maxWidth) {
                float fit = maxWidth / subWidth;
                subWidth *= fit;
                subHeight *= fit;
            }
            // 贴着主行底边往下排 —— 两行各自的留白合起来就是行间距。
            // 翻译不做高亮：主行已经在亮了，两行一起推会显得很吵。
            drawTinted(subTexture, y + height * 0.5f + subHeight * 0.5f,
                    subWidth, subHeight, alpha * 0.86f,
                    0.70f, 0.74f, 0.82f);
        }
    }

    /**
     * 垫在歌词后面的巨型装饰字：把当前这行放大到很淡的一层当背景纹理。
     *
     * **曾经这里还有一整套线条装饰**（外框 + 四角标、焦点行上下的引导线、三圈呼吸细框），
     * 用户明确要求「原生壁纸有线条背景去掉」，已经整块删除，连画线的 stroke() 一起。
     * 别再往这里加框线 —— 需要线条的话应该去叠层那一层做。
     */
    private void drawBackdropText(WallpaperLyricsState.Snapshot snapshot, float centerY, float lineStep) {
        if (quadProgram == 0 || snapshot.isEmpty()) {
            return;
        }
        if (!"sonnet".equals(activeMode)) {
            return;
        }
        int index = snapshot.indexAt(snapshot.positionMs());
        if (index >= snapshot.lines.length) {
            return;
        }
        String current = snapshot.lines[index].text;
        if (current == null) {
            return;
        }
        float width = surfaceWidth * 0.84f;

        if (tb("showGiantDecorativeText", true) && current.trim().length() > 0) {
            int giantFont = Math.round(clamp(surfaceHeight * 0.062f, 26f, 84f) * 2.2f);
            TextTexture giant = textureFor(current, giantFont);
            if (giant != null) {
                float ratio = Math.min(1f, width / giant.width);
                drawCentered(giant, centerY - lineStep * 0.15f,
                        giant.width * ratio, giant.height * ratio, 0.055f, -1f);
            }
        }
    }

    private void drawCentered(TextTexture texture, float centerYPx, float widthPx, float heightPx,
                              float alpha, float progress) {
        drawCentered(texture, centerYPx, widthPx, heightPx, alpha, progress, false);
    }

    /**
     * @param wholeLine true = 整行渐变：进度只推整行亮度，不做横向擦除（不会逐字亮起来）。
     */
    private void drawCentered(TextTexture texture, float centerYPx, float widthPx, float heightPx,
                              float alpha, float progress, boolean wholeLine) {
        float left = (surfaceWidth - widthPx) * 0.5f;
        float top = centerYPx - heightPx * 0.5f;
        // 没点亮的底色用暗白；整行模式下整行铺主题渐变，进度把亮度推上去。
        // 边缘光的强度跟着光晕走：这就是「歌词有多亮」的观感来源之一。
        drawTexturedQuad(texture.textureId, left, top, widthPx, heightPx,
                0.62f, 0.66f, 0.72f, alpha, progress, 0f, highlightBoost(), wholeLine);
    }

    /**
     * **逐字上浮**：整行一张纹理，按字切成一条条 UV 分别画。
     *
     * 每个字在自己的小时间窗里（窗宽 `CHAR_SPAN × 行长`，第 i 个字的起点依次错开）
     * 一边往上浮 `CHAR_RISE × 行距`，一边从暗白过渡到主题渐变 —— 唱到哪个字，
     * 哪个字浮起来。渐变是按**整行纹理坐标**取的，所以字与字之间颜色是连续的，
     * 不会每个字各自从头渐变一遍。
     *
     * 不按字各栅格化一张纹理：那会把 TEXTURE_CACHE_LIMIT 撑爆（一行十几个字 ×
     * 一整首歌），而按 UV 切只多几次 draw call。
     */
    private void drawPerChar(TextTexture texture, float centerYPx, float widthPx, float heightPx,
                             float alpha, float lineProgress, float lineStep) {
        float[] bounds = texture.charBounds;
        int count = bounds == null ? 0 : bounds.length - 1;
        if (count <= 0 || widthPx <= 0f) {
            drawCentered(texture, centerYPx, widthPx, heightPx, alpha,
                    clamp(lineProgress, 0f, 1f), true);
            return;
        }
        float left = (surfaceWidth - widthPx) * 0.5f;
        float top = centerYPx - heightPx * 0.5f;
        float texW = Math.max(1f, texture.width);
        float step = count > 1 ? (1f - CHAR_SPAN) / (count - 1) : 0f;
        for (int c = 0; c < count; c++) {
            float t = clamp((lineProgress - c * step) / CHAR_SPAN, 0f, 1f);
            float u0 = bounds[c] / texW;
            float u1 = bounds[c + 1] / texW;
            float charWidth = Math.max(1f, (u1 - u0) * widthPx);
            float rise = -lineStep * CHAR_RISE * easeOutCubic(t);
            drawTexturedQuad(texture.textureId, left + u0 * widthPx, top + rise,
                    charWidth, heightPx, 0.62f, 0.66f, 0.72f, alpha,
                    t, 0f, highlightBoost(), true, u0, 0f, u1 - u0, 1f);
        }
    }

    /** 翻译行：居中、比主行暗一点，不做高亮擦除。 */
    /**
     * 歌词擦除边缘那圈主题色光的强度。
     *
     * 直接复用 Style.glow —— 那个本来就是「这个模式有多闪」，
     * 同一个值同时喂给背景光晕和歌词高亮，模式之间的观感差才会连成一片。
     * 上限夹一下：追随 get out of hand 的边缘光会把字糊成一团色。
     */
    // ---- 实验台配置 ----

    /**
     * 取当前模式的一项配置。字段缺失时返回 fallback ——
     * Web 侧每次只发当前模式的字段，切换模式时旧字段自然消失、新字段自然到位，
     * 不需要任何「清空」逻辑。
     */
    private float tf(String key, float fallback) {
        Float value = tuning.get(key);
        return value == null ? fallback : value;
    }

    /** 布尔开关：0 = 关。缺省视为「开」（默认值多为 true）。 */
    private boolean tb(String key, boolean fallback) {
        Float value = tuning.get(key);
        if (value == null) return fallback;
        return value >= 0.5f;
    }

    private float highlightBoost() {
        return Math.min(1.6f, Math.max(0.5f, style.glow));
    }

    private void drawTinted(TextTexture texture, float centerYPx, float widthPx, float heightPx,
                            float alpha, float r, float g, float b) {
        float left = (surfaceWidth - widthPx) * 0.5f;
        float top = centerYPx - heightPx * 0.5f;
        drawTexturedQuad(texture.textureId, left, top, widthPx, heightPx, r, g, b, alpha, -1f, 0f, 1f);
    }

    private void drawTexturedQuad(int textureId, float leftPx, float topPx, float widthPx,
                                  float heightPx, float r, float g, float b, float alpha,
                                  float progress, float useTextureColor, float glowBoost) {
        drawTexturedQuad(textureId, leftPx, topPx, widthPx, heightPx, r, g, b, alpha,
                progress, useTextureColor, glowBoost, false);
    }

    /**
     * @param wholeLine 整行模式：进度推的是整行亮度，不是横向擦除到第几个字。
     */
    private void drawTexturedQuad(int textureId, float leftPx, float topPx, float widthPx,
                                  float heightPx, float r, float g, float b, float alpha,
                                  float progress, float useTextureColor, float glowBoost,
                                  boolean wholeLine) {
        drawTexturedQuad(textureId, leftPx, topPx, widthPx, heightPx, r, g, b, alpha,
                progress, useTextureColor, glowBoost, wholeLine, 0f, 0f, 1f, 1f);
    }

    /**
     * @param wholeLine 整行模式：进度推的是整行亮度，不是横向擦除到第几个字。
     * @param uvX/uvY/uvW/uvH 只采样纹理里的这一小块（逐字上浮按字切 UV）。
     */
    private void drawTexturedQuad(int textureId, float leftPx, float topPx, float widthPx,
                                  float heightPx, float r, float g, float b, float alpha,
                                  float progress, float useTextureColor, float glowBoost,
                                  boolean wholeLine, float uvX, float uvY, float uvW, float uvH) {
        if (quadProgram == 0) {
            return;
        }
        GLES20.glUseProgram(quadProgram);

        int position = GLES20.glGetAttribLocation(quadProgram, "aPosition");
        int uv = GLES20.glGetAttribLocation(quadProgram, "aUv");
        bindQuad(position, uv);

        // 像素坐标 → NDC。uRect 记的是矩形**下边**那条线（aPosition.y=0 落在那里），
        // 高度是往上长的，所以 y 必须先减掉 h：少减这一步的话整个矩形会上移自身高度，
        // 歌词只是偏了一行看不太出来，但铺满全屏的背景图会整个跑到屏幕外面去 ——
        // 表现就是「选了图却什么都没有」。
        float x = (leftPx / surfaceWidth) * 2f - 1f;
        float w = (widthPx / surfaceWidth) * 2f;
        float h = (heightPx / surfaceHeight) * 2f;
        float y = 1f - (topPx / surfaceHeight) * 2f - h;
        GLES20.glUniform4f(GLES20.glGetUniformLocation(quadProgram, "uRect"), x, y, w, h);
        GLES20.glUniform4f(GLES20.glGetUniformLocation(quadProgram, "uUvRect"),
                uvX, uvY, uvW, uvH);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uColor"), r, g, b);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uActive"),
                coverTint[0], coverTint[1], coverTint[2]);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uActive2"),
                coverTint2[0], coverTint2[1], coverTint2[2]);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uGlow"),
                accent[0] * glowBoost, accent[1] * glowBoost, accent[2] * glowBoost);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uAlpha"), alpha);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uProgress"), progress);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uWholeLine"),
                wholeLine ? 1f : 0f);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uUseTexColor"),
                useTextureColor);

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(quadProgram, "uTexture"), 0);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        unbindQuad(position, uv);
    }

    // ---- 纹理 ----

    private TextTexture textureFor(String text, int fontPx) {
        String key = text + '@' + fontPx;
        TextTexture cached = textures.get(key);
        if (cached != null) {
            return cached;
        }

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.WHITE);
        paint.setTypeface(activeTypeface == null
                ? Typeface.create("sans-serif", Typeface.BOLD)
                : activeTypeface);
        paint.setTextSize(fontPx);
        paint.setTextAlign(Paint.Align.LEFT);

        int pad = Math.max(8, Math.round(fontPx * 0.25f));
        float textWidth = paint.measureText(text);
        Paint.FontMetrics metrics = paint.getFontMetrics();
        float textHeight = metrics.descent - metrics.ascent;
        int bitmapWidth = Math.max(1, (int) Math.ceil(textWidth + pad * 2f));
        int bitmapHeight = Math.max(1, (int) Math.ceil(textHeight + pad * 2f));

        Bitmap bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawText(text, pad, pad - metrics.ascent, paint);

        int textureId = upload(bitmap);
        bitmap.recycle();
        if (textureId == 0) {
            return null;
        }
        TextTexture texture = new TextTexture(textureId, bitmapWidth, bitmapHeight,
                measureCharBounds(text, paint, pad));
        textures.put(key, texture);
        return texture;
    }

    /**
     * 逐字测量：返回每个字在位图上的右边界（长度 = 字数 + 1，第 0 个是左 padding）。
     *
     * 按**码点**切而不是按 char —— 表情是代理对，按 char 切会把一个表情切成两半，
     * 逐字上浮时那半边就会单独飘出去。
     */
    private static float[] measureCharBounds(String text, Paint paint, int pad) {
        int count = text.codePointCount(0, text.length());
        float[] bounds = new float[count + 1];
        float x = pad;
        int index = 1;
        bounds[0] = pad;
        for (int offset = 0; offset < text.length(); ) {
            int codePoint = text.codePointAt(offset);
            int next = offset + Character.charCount(codePoint);
            // 带整串上下文地量：单独 measure 一个字符拿不到连写/字距调整后的宽度。
            x += paint.measureText(text, offset, next);
            if (index < bounds.length) {
                bounds[index] = x;
            }
            index++;
            offset = next;
        }
        return bounds;
    }

    /**
     * 歌词字体。用户没选就用系统 sans-serif；选了但文件读不出来（选错文件、文件损坏）
     * 也静默回落，不能让一个坏字体把整个壁纸带走。
     */
    private void syncFont(String fontKey) {
        if (fontKey == null) {
            if (loadedFontKey != null) {
                loadedFontKey = null;
                activeTypeface = null;
                // 字体变了，已经栅格化的行全部作废。
                clearTextures();
            }
            return;
        }
        if (fontKey.equals(loadedFontKey)) {
            return;
        }
        loadedFontKey = fontKey;
        Typeface loaded = WallpaperLyricsFont.load(context);
        if (loaded == null) {
            Log.w(TAG, "The chosen lyrics font could not be loaded; falling back to sans-serif");
            activeTypeface = null;
        } else {
            activeTypeface = loaded;
        }
        clearTextures();
    }

    private void clearTextures() {
        for (TextTexture texture : textures.values()) {
            GLES20.glDeleteTextures(1, new int[] { texture.textureId }, 0);
        }
        textures.clear();
    }

    private void syncCover(String coverBase64) {
        if (coverBase64 == null || coverBase64.equals(loadedCoverKey)) {
            return;
        }
        Bitmap decoded = decodeCover(coverBase64);
        loadedCoverKey = coverBase64;
        if (decoded == null) {
            return;
        }
        if (coverTexture != 0) {
            GLES20.glDeleteTextures(1, new int[] { coverTexture }, 0);
            coverTexture = 0;
        }
        Bitmap blurred = blurredCover(decoded, blurAmount);
        coverTexture = upload(blurred);
        coverWidth = blurred.getWidth();
        coverHeight = blurred.getHeight();
        blurred.recycle();
        decoded.recycle();
    }

    private static Bitmap decodeCover(String base64) {
        try {
            int comma = base64.indexOf(',');
            String payload = comma >= 0 ? base64.substring(comma + 1) : base64;
            byte[] bytes = android.util.Base64.decode(payload, android.util.Base64.DEFAULT);
            Bitmap source = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (source == null || source.getWidth() < 2 || source.getHeight() < 2) {
                return null;
            }
            // 封面可能很大，先压到 768 再模糊，避免上传一张几千像素的纹理。
            // 768 而不是 512：模糊滑杆拉到 0 时这张图就是画面本身，512 在全屏上偏软。
            int edge = Math.max(source.getWidth(), source.getHeight());
            if (edge > 768) {
                float ratio = 768f / edge;
                Bitmap scaled = Bitmap.createScaledBitmap(source,
                        Math.round(source.getWidth() * ratio),
                        Math.round(source.getHeight() * ratio), true);
                source.recycle();
                return scaled;
            }
            return source;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to decode the wallpaper cover", error);
            return null;
        }
    }

    private static int upload(Bitmap bitmap) {
        int[] ids = new int[1];
        GLES20.glGenTextures(1, ids, 0);
        if (ids[0] == 0) {
            return 0;
        }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0]);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        return ids[0];
    }

    /** 高斯模糊的工作尺寸上限。模糊后已无高频，再放大回全屏也不会出块。 */
    private static final int BLUR_WORK_EDGE = 768;
    /** amount=1 时的 σ，按工作图短边的比例算。 */
    private static final float BLUR_MAX_SIGMA_RATIO = 0.075f;

    /**
     * 高斯模糊。
     *
     * 注意「缩小再放大」**不是**模糊，那是降采样：缩到 200px 再放大回 1080，
     * 每个像素被摊成一个大方块，出来的就是马赛克 —— 这正是之前那版的做法。
     * 这里跑的是货真价实的高斯（见 gaussianBlur），缩到工作尺寸只是为了速度。
     *
     * 强度 amount∈[0,1] 映射到 σ（工作图上的像素数）：0 是一点不糊，1 约到短边的 7.5%。
     */
    static Bitmap blurredCover(Bitmap source, float amount) {
        try {
            float a = clamp(amount, 0f, 1f);
            if (a <= 0.01f) return source;
            int sw = source.getWidth();
            int sh = source.getHeight();
            if (sw < 2 || sh < 2) return source;

            // 降到工作尺寸纯粹是为了速度。模糊之后的图已经不含高频分量，
            // 交给 GL 双线性放大回全屏时不会再出块 —— 出块的是「只缩不放」不是降采样本身。
            float scale = Math.min(1f, BLUR_WORK_EDGE / (float) Math.max(sw, sh));
            int w = Math.max(8, Math.round(sw * scale));
            int h = Math.max(8, Math.round(sh * scale));
            Bitmap work = (w == sw && h == sh) ? source : Bitmap.createScaledBitmap(source, w, h, true);

            float sigma = a * BLUR_MAX_SIGMA_RATIO * Math.min(w, h);
            if (sigma < 0.5f) return work;
            Bitmap blurred = gaussianBlur(work, sigma);
            if (work != source) {
                work.recycle();
            }
            return blurred;
        } catch (Throwable error) {
            Log.w(TAG, "Blur failed; using the raw cover", error);
            return source;
        }
    }

    /**
     * 高斯模糊：三次盒式模糊逼近高斯核（Ivan Kutskir 的经典做法）。
     *
     * 真按高斯核卷积是 O(半径²)，半径一大就跑不动；三次盒式是 O(1) 每像素，与半径无关，
     * 而三次叠加的结果与真高斯的误差在 3% 以内，肉眼无从分辨 —— RenderScript 的
     * ScriptIntrinsicBlur 和各大图片库走的都是这条路。
     *
     * 可分离：横竖各一遍，所以是 3 通道 × 3 次 × 2 个方向。
     * alpha 不动：封面与背景图都是不透明的，为它再多跑一遍不值得。
     */
    private static Bitmap gaussianBlur(Bitmap source, float sigma) {
        int w = source.getWidth();
        int h = source.getHeight();
        int[] pixels = new int[w * h];
        source.getPixels(pixels, 0, w, 0, 0, w, h);

        int[] boxes = boxesForGauss(sigma, 3);
        float[] channel = new float[w * h];
        float[] temp = new float[w * h];
        for (int shift : CHANNEL_SHIFTS) {
            for (int i = 0; i < pixels.length; i++) {
                channel[i] = (pixels[i] >> shift) & 0xFF;
            }
            for (int pass = 0; pass < boxes.length; pass++) {
                boxBlur(channel, temp, w, h, (boxes[pass] - 1) / 2);
            }
            int keep = ~(0xFF << shift);
            for (int i = 0; i < pixels.length; i++) {
                int value = Math.round(channel[i]);
                pixels[i] = (pixels[i] & keep) | (Math.min(255, Math.max(0, value)) << shift);
            }
        }

        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(pixels, 0, w, 0, 0, w, h);
        return out;
    }

    /** R / G / B 在 0xAARRGGBB 里的位移。 */
    private static final int[] CHANNEL_SHIFTS = { 16, 8, 0 };

    /** 一次可分离盒式模糊：横向一遍再纵向一遍，窗口宽度 2r+1。 */
    private static void boxBlur(float[] source, float[] temp, int w, int h, int r) {
        boxBlurHorizontal(source, temp, w, h, r);
        boxBlurVertical(temp, source, w, h, r);
    }

    private static void boxBlurHorizontal(float[] source, float[] target, int w, int h, int r) {
        float scale = 1f / (r + r + 1);
        for (int y = 0; y < h; y++) {
            int row = y * w;
            // 左边界外按「重复边缘像素」处理：窗口里 x<0 的那些格都算作 source[0]。
            float acc = source[row] * (r + 1);
            for (int x = 1; x <= r; x++) acc += source[row + Math.min(x, w - 1)];
            for (int x = 0; x < w; x++) {
                target[row + x] = acc * scale;
                acc += source[row + Math.min(x + r + 1, w - 1)] - source[row + Math.max(x - r, 0)];
            }
        }
    }

    private static void boxBlurVertical(float[] source, float[] target, int w, int h, int r) {
        float scale = 1f / (r + r + 1);
        for (int x = 0; x < w; x++) {
            float acc = source[x] * (r + 1);
            for (int y = 1; y <= r; y++) acc += source[Math.min(y, h - 1) * w + x];
            for (int y = 0; y < h; y++) {
                target[y * w + x] = acc * scale;
                acc += source[Math.min(y + r + 1, h - 1) * w + x] - source[Math.max(y - r, 0) * w + x];
            }
        }
    }

    /**
     * 把 σ 拆成 n 个盒式窗口的宽度。
     *
     * 单个盒式模糊是方波，两个叠起来是三角波，三个已经非常接近钟形。
     * 公式来自「n 个宽度 w 的盒式模糊 ≈ σ 的高斯」这个等价关系的解析解。
     */
    private static int[] boxesForGauss(float sigma, int n) {
        float ideal = (float) Math.sqrt((12 * sigma * sigma / n) + 1);
        int smaller = (int) Math.floor(ideal);
        if (smaller % 2 == 0) smaller--;
        if (smaller < 1) smaller = 1;
        int larger = smaller + 2;
        float mIdeal = (12 * sigma * sigma - n * smaller * smaller - 4 * n * smaller - 3 * n)
                / (-4 * smaller - 4);
        int m = Math.round(mIdeal);
        int[] sizes = new int[n];
        for (int i = 0; i < n; i++) {
            sizes[i] = i < m ? smaller : larger;
        }
        return sizes;
    }


    /**
     * 把主题色抬到「压在深浅不定的底图上也看得清」的程度。
     *
     * **不强行加饱和度。** 早先从封面取色时会把饱和度硬拉到 0.42 以上，那对偏暗的封面主色
     * 是必要的；可主题色本身已经挑过可读性了，再拉一次就是把 #f4f4f5 这种近白的高亮色
     * 变成粉红 —— 那是凭空造色，不是跟着主题。所以只动明度：过暗的抬一点，让它不至于
     * 在深色底图上消失；本来够亮的几乎不动。
     */
    private static float[] liftForText(float[] hsv) {
        return new float[] {
                hsv[0],
                hsv[1],
                Math.min(1f, Math.max(0.62f, hsv[2] * 0.5f + 0.5f)),
        };
    }

    private static float[] rgbOfHsv(float[] hsv) {
        int rgb = Color.HSVToColor(hsv);
        return new float[] {
                ((rgb >> 16) & 0xFF) / 255f,
                ((rgb >> 8) & 0xFF) / 255f,
                (rgb & 0xFF) / 255f,
        };
    }

    /**
     * 歌词高亮的两个端点色，取自 App 当前主题的主色。
     *
     * 第二个色是把主色旋一点色相得到的：主题只给了一个主色，直接复制成两端的话
     * 那就不叫渐变而是一条实色。旋 0.085（约 30°）足够看出方向，又不至于跑成另一个色系。
     *
     * 主题主色接近无彩色时（比如默认的近白高亮），旋转在视觉上等于没转，两端就是同一个白 ——
     * 这是对的：界面上的歌词那时候本来就是白的，壁纸不该自己另造一个颜色出来。
     */
    private static float[][] tintsFromTheme(float[] accentRgb) {
        float[] hsv = new float[3];
        Color.RGBToHSV(
                Math.round(clamp(accentRgb[0], 0f, 1f) * 255f),
                Math.round(clamp(accentRgb[1], 0f, 1f) * 255f),
                Math.round(clamp(accentRgb[2], 0f, 1f) * 255f),
                hsv);
        float[] first = liftForText(hsv);
        float[] second = liftForText(new float[] { (hsv[0] + 0.085f) % 1f, hsv[1], hsv[2] });
        return new float[][] { first, second };
    }

    /** 1×1 白色纹理：纯色矩形（轨道 / 进度条）也要绑一张纹理才能走同一个着色器。 */
    private static int createSolidTexture() {
        Bitmap bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.WHITE);
        int texture = upload(bitmap);
        bitmap.recycle();
        return texture;
    }

    // ---- GL 样板 ----

    private int createUnitQuad() {
        float[] vertices = {
                0f, 0f, 0f, 0f,
                1f, 0f, 1f, 0f,
                0f, 1f, 0f, 1f,
                1f, 1f, 1f, 1f,
        };
        FloatBuffer buffer = ByteBuffer.allocateDirect(vertices.length * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer();
        buffer.put(vertices).position(0);

        int[] ids = new int[1];
        GLES20.glGenBuffers(1, ids, 0);
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, ids[0]);
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, vertices.length * 4, buffer, GLES20.GL_STATIC_DRAW);
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0);
        return ids[0];
    }

    private void bindQuad(int positionHandle, int uvHandle) {
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quadBuffer);
        GLES20.glEnableVertexAttribArray(positionHandle);
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 16, 0);
        if (uvHandle >= 0) {
            GLES20.glEnableVertexAttribArray(uvHandle);
            GLES20.glVertexAttribPointer(uvHandle, 2, GLES20.GL_FLOAT, false, 16, 8);
        }
    }

    private void unbindQuad(int positionHandle, int uvHandle) {
        GLES20.glDisableVertexAttribArray(positionHandle);
        if (uvHandle >= 0) {
            GLES20.glDisableVertexAttribArray(uvHandle);
        }
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0);
    }

    private static int buildProgram(String vertexSource, String fragmentSource) {
        int vertexShader = compile(GLES20.GL_VERTEX_SHADER, vertexSource);
        int fragmentShader = compile(GLES20.GL_FRAGMENT_SHADER, fragmentSource);
        if (vertexShader == 0 || fragmentShader == 0) {
            return 0;
        }
        int program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vertexShader);
        GLES20.glAttachShader(program, fragmentShader);
        GLES20.glLinkProgram(program);
        int[] linked = new int[1];
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
        if (linked[0] == 0) {
            Log.e(TAG, "Link failed: " + GLES20.glGetProgramInfoLog(program));
            GLES20.glDeleteProgram(program);
            return 0;
        }
        GLES20.glDeleteShader(vertexShader);
        GLES20.glDeleteShader(fragmentShader);
        return program;
    }

    private static int compile(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] compiled = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0);
        if (compiled[0] == 0) {
            Log.e(TAG, "Shader compile failed: " + GLES20.glGetShaderInfoLog(shader));
            GLES20.glDeleteShader(shader);
            return 0;
        }
        return shader;
    }

    private static float approach(float value, float target, float deltaSeconds, float speed) {
        float factor = 1f - (float) Math.exp(-deltaSeconds * speed);
        return value + (target - value) * factor;
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    /** 缓出：快进慢收。用于换行走入，落位那一下不会有「顿」感。 */
    private static float easeOutCubic(float t) {
        float v = clamp(t, 0f, 1f);
        float inv = 1f - v;
        return 1f - inv * inv * inv;
    }

    private static float[] rgbFromColor(int color) {
        return new float[] {
                ((color >> 16) & 0xFF) / 255f,
                ((color >> 8) & 0xFF) / 255f,
                (color & 0xFF) / 255f,
        };
    }

    private static final class TextTexture {
        final int textureId;
        final int width;
        final int height;
        /**
         * 每个字在**位图**上的左右边界（像素，含左侧 padding），长度 = 字数 + 1。
         * 逐字上浮要按字分别画，就得知道每个字在整行纹理里占哪一段 UV。
         * 整行只有一张纹理，切 UV 比每个字各栅格化一张省得多（不会撑爆纹理缓存）。
         */
        final float[] charBounds;

        TextTexture(int textureId, int width, int height, float[] charBounds) {
            this.textureId = textureId;
            this.width = width;
            this.height = height;
            this.charBounds = charBounds;
        }

        void dispose() {
            GLES20.glDeleteTextures(1, new int[] { textureId }, 0);
        }
    }

    // ---- 着色器 ----

    private static final String BACKGROUND_VERTEX =
            "attribute vec2 aPosition;\n"
            + "attribute vec2 aUv;\n"
            + "uniform vec4 uRect;\n"
            + "varying vec2 vUv;\n"
            + "void main() {\n"
            + "  vUv = aUv;\n"
            + "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n"
            + "  gl_Position = vec4(ndc, 0.0, 1.0);\n"
            + "}\n";

    private static final String BACKGROUND_FRAGMENT =
            "precision mediump float;\n"
            + "varying vec2 vUv;\n"
            + "uniform float uTime;\n"
            + "uniform float uAspect;\n"
            + "uniform float uOffsetX;\n"
            + "uniform vec3 uAccent;\n"
            + "uniform vec3 uBase;\n"
            + "uniform float uMotion;\n"
            + "uniform float uBlob;\n"
            + "uniform float uDust;\n"
            + "uniform float uGlow;\n"
            + "uniform float uPpGrain;\n"
            + "uniform float uPpContrast;\n"
            + "uniform float uPpVignette;\n"
            + "void main() {\n"
            + "  vec2 p = vec2(vUv.x * uAspect, vUv.y);\n"
            + "  float t = uTime * 0.06 * uMotion;\n"
            + "  vec2 c1 = vec2((0.30 + 0.12 * sin(t * 1.1) + uOffsetX * 0.12) * uAspect,"
            + " 0.26 + 0.10 * cos(t * 0.9));\n"
            + "  vec2 c2 = vec2((0.72 + 0.10 * cos(t * 0.8) + uOffsetX * 0.12) * uAspect,"
            + " 0.72 + 0.12 * sin(t * 1.3));\n"
            + "  float g1 = smoothstep(0.95 * uBlob, 0.0, distance(p, c1));\n"
            + "  float g2 = smoothstep(0.95 * uBlob, 0.0, distance(p, c2));\n"
            + "  vec3 col = uBase + uAccent * (g1 * 0.42 + g2 * 0.28) * uGlow;\n"
            // 缓慢上浮的细颗粒，给静止的画面一点呼吸感。
            + "  float dust = 0.0;\n"
            + "  for (int i = 0; i < 8; i++) {\n"
            + "    float fi = float(i);\n"
            + "    float speed = (0.020 + 0.008 * fi) * uMotion;\n"
            + "    float x = fract(0.137 * fi + 0.05 * sin(uTime * 0.35 + fi));\n"
            + "    float y = fract(0.913 - mod(uTime * speed + 0.171 * fi, 1.0));\n"
            + "    float r = 0.004 + 0.006 * fract(fi * 0.371);\n"
            + "    dust += smoothstep(r, 0.0, distance(p, vec2(x * uAspect, y)));\n"
            + "  }\n"
            + "  col += vec3(0.55, 0.58, 0.68) * dust * 0.16 * uDust;\n"
            + "  float vignette = smoothstep(1.25, 0.30, distance(vUv, vec2(0.5)));\n"
            + "  float vig = mix(0.52, 1.0, vignette);\n"
            // postProcessVignette 超过基准档(0.85)的部分继续压暗：二次曲线比线性更像真镜头。
            + "  vig *= mix(1.0, vig, clamp((uPpVignette - 0.85) / 1.15, 0.0, 1.0));\n"
            // 传 -1 表示应用侧关掉了暗角：整条压暗都不做，边缘不再收黑。
            + "  vig = mix(vig, 1.0, step(uPpVignette, -0.5));\n"
            + "  col *= vig;\n"
            // 胶片颗粒：一层与时间相关的白噪声。这是实验台里 postProcessGrain 的原生等价物。
            + "  if (uPpGrain > 0.001) {\n"
            + "    float grain = fract(sin(dot(p * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);\n"
            + "    col += (grain - 0.5) * uPpGrain * 0.28;\n"
            + "  }\n"
            // 对比度：绕中灰拉伸。postProcessContrast 反过来("-1")也能用，只是会压平。
            + "  col = clamp((col - 0.5) * (1.0 + uPpContrast) + 0.5, 0.0, 1.0);\n"
            + "  gl_FragColor = vec4(col, 1.0);\n"
            + "}\n";

    private static final String QUAD_VERTEX =
            "attribute vec2 aPosition;\n"
            + "attribute vec2 aUv;\n"
            + "uniform vec4 uRect;\n"
            // 只采样纹理里的一小块（逐字上浮按字切 UV）。整行绘制时传 (0,0,1,1)。
            + "uniform vec4 uUvRect;\n"
            + "varying vec2 vUv;\n"
            + "void main() {\n"
            // 位图第 0 行在顶部，纹理坐标 v=0 在底部，所以要翻过来。
            + "  vUv = vec2(uUvRect.x + aUv.x * uUvRect.z,\n"
            + "             1.0 - (uUvRect.y + aUv.y * uUvRect.w));\n"
            + "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n"
            + "  gl_Position = vec4(ndc, 0.0, 1.0);\n"
            + "}\n";

    private static final String QUAD_FRAGMENT =
            "precision mediump float;\n"
            + "varying vec2 vUv;\n"
            + "uniform sampler2D uTexture;\n"
            + "uniform vec3 uColor;\n"
            + "uniform vec3 uActive;\n"
            + "uniform vec3 uActive2;\n"
            + "uniform vec3 uGlow;\n"
            + "uniform float uAlpha;\n"
            + "uniform float uProgress;\n"
            + "uniform float uWholeLine;\n"
            + "uniform float uUseTexColor;\n"
            + "void main() {\n"
            + "  vec4 tex = texture2D(uTexture, vUv);\n"
            + "  float a = tex.a * uAlpha;\n"
            + "  vec3 rgb = mix(uColor, tex.rgb, uUseTexColor);\n"
            + "  if (uProgress >= 0.0) {\n"
            // 整行模式：整行铺满渐变，进度只把亮度从「压暗」推到「满色」。
            // 没有横向擦除，所以不存在「一个字一个字亮起来 / 浮起来」的观感。
            + "    if (uWholeLine > 0.5) {\n"
            + "      vec3 g2 = mix(uActive, uActive2, clamp(vUv.x, 0.0, 1.0));\n"
            + "      vec3 d2 = mix(uColor, g2, 0.22);\n"
            + "      rgb = mix(d2, g2, clamp(uProgress, 0.0, 1.0));\n"
            + "    } else {\n"
            + "    float edge = smoothstep(uProgress - 0.010, uProgress + 0.010, vUv.x);\n"
            // 渐变铺满**整行**：沿行方向在 uActive → uActive2 之间插值，两端色取自当前主题。
            // 唱过的那一段用满饱和的渐变，没唱到的用同一条渐变压暗 ——
            // 这是状态栏歌词那类插件的通行做法：整行先有颜色，进度再把亮度推上去，
            // 而不是「白字 + 一小块彩色高亮」。
            + "    vec3 grad = mix(uActive, uActive2, clamp(vUv.x, 0.0, 1.0));\n"
            + "    vec3 dim = mix(uColor, grad, 0.20);\n"
            + "    rgb = mix(grad, dim, edge);\n"
            + "    float glow = exp(-pow((vUv.x - uProgress) * 26.0, 2.0));\n"
            + "    rgb += uGlow * glow * 0.95;\n"
            + "    }\n"
            + "  }\n"
            // 位图是预乘 alpha 的，这里按预乘输出，配合 blendFunc(ONE, 1-SRC_ALPHA)。
            + "  gl_FragColor = vec4(rgb * a, a);\n"
            + "}\n";
}
