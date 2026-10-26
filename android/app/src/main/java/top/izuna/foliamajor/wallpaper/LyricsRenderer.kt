package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.media.MediaPlayer
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.util.Log
import android.view.Surface

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.LinkedHashMap

import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

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
class LyricsRenderer(context: Context?) : GLSurfaceView.Renderer {

    private val context: Context? = context?.applicationContext

    /**
     * 一种可视化风格在壁纸上的落地参数。
     *
     * App 里的十几种可视化是 PixiJS 场景，逐帧照搬到壁纸上做不到（壁纸只能画原生 Surface）。
     * 这里退一步做「风格对齐」：每种模式抽出一小组观感参数，背景的流速、光团、颗粒、
     * 歌词的行距与高亮方式各不相同，选中什么模式，壁纸就呈现那种气质。
     */
    private class Style(
            val flowSpeed: Float,
            val blobScale: Float,
            val dust: Float,
            val glow: Float,
            val lineSpacing: Float,
            val falloff: Float,
            val currentScale: Float,
        /**
         * 0 = 逐字擦除高亮（按行内进度在纹理上横向扫过去），
         * 1 = 整行渐变（整行从一开始就铺满主题渐变，进度只把整行的亮度往上推，不擦除），
         * 2 = 不做高亮，
         * 3 = **逐字上浮**（每个字按自己的小进度依次浮起来并点亮渐变，见 CHAR_SPAN/CHAR_RISE）。
         */
            val textEffect: Int,
        /**
         * 跟唱上浮：当前行在唱的过程中**整行一起**往上抬多少（单位 = 行距）。
         * 逐字上浮（textEffect = 3）时给 0 —— 那时动的是每个字，整行再抬一次就是双重位移。
         */
            val progressLift: Float)

    companion object {
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
        private val LYRICS_STYLE =
                Style(0.25f, 0.80f, 0.0f, 0.75f, 0.125f, 0.24f, 1.00f, 3, 0.0f)

        /** 模式参数保留在签名里（调用方照旧传当前模式），但已经不再参与取值。 */
        private fun styleFor(mode: String): Style {
            return LYRICS_STYLE
        }

        private const val TAG = "LyricsRenderer"
        /**
         * 待机（没有歌）时的配色。底色调亮一档、高亮给足饱和的紫，
         * 这样只有背景在跑的时候画面是有内容的，而不是一块黑。
         */
        private val IDLE_BASE: Int = 0xFF16162A.toInt()
        private val IDLE_ACCENT: Int = 0xFF8A6BFF.toInt()
        /** 一次最多画这么多行（当前行各向上下展开）。 */
        private const val VISIBLE_SPAN = 3
        private const val TEXTURE_CACHE_LIMIT = 24
        /** 翻译行相对主行的字号比例。 */
        private const val TRANSLATION_FONT_RATIO = 0.62f
        /**
         * 一行文本栅格化后的高度 ≈ 字号 × 这个系数（见 textureFor：行高 + 上下各 0.25 字号的留白）。
         * 算双行行距时用它，免得相邻两句叠在一起。
         */
        private const val TEXTURE_HEIGHT_FACTOR = 1.62f
        /** 换行走入的时长（秒）。短一点才叫「一点点动画」——长了就变成拖尾。 */
        private const val LINE_ENTER_SECONDS = 0.42f
        /** 走入时从下方多远滑上来（单位 = 行距）。 */
        private const val LINE_ENTER_RISE = 0.16f
        /** 焦点行极缓的呼吸幅度（亮度 / 缩放）。只是让字不像贴图，幅度必须很小。 */
        private const val LINE_BREATH = 0.05f
        /** 逐字上浮：单个字浮起来的时长占整行时长的比例，剩下的时间用来把字依次错开。 */
        private const val CHAR_SPAN = 0.45f
        /** 逐字上浮：一个字浮起多高（单位 = 行距）。 */
        private const val CHAR_RISE = 0.18f
        /**
         * 边缘行「飞出屏幕外」：向上额外走多远（单位 = 行距）。
         *
         * 数值必须够大：最外侧那行原本就在屏幕上方 22% 处，走不到一个整屏高度的一半
         * 就谈不上"飞出去"—— 用户看到就只是"淡淡地没了"。3.6 个行距 ≈ 半屏，
         * 配合下面的位移曲线，在还看得见（alpha ≈ 0.3）的时候就已经飞出屏幕外了。
         */
        private const val EXIT_FLY = 3.60f
        /** 边缘行「出现」：从屏幕下方多远滑进来（单位 = 行距）。 */
        private const val ENTER_RISE = 1.10f
        /** 边缘行飞出时额外缩多少（1 = 原大小）。 */
        private const val EXIT_SHRINK = 0.12f
        /**
         * 亮度衰减最多算到这么远（单位 = 行）。再往外就不再继续压暗 ——
         * 否则最外侧那行轮到它做飞出/出现动画时已经暗得看不见了。
         */
        private const val FALLOFF_MAX_DISTANCE = 2f

        /*
         * 文本的**主色 / 次色**（没唱到的那些行、以及翻译行）。
         *
         * 这两样原来在这里是写死的灰白（0.62/0.66/0.72 与 0.70/0.74/0.82）：
         * 只有高亮那部分跟着 `snapshot.accent` 走。于是 App 里换成 AI / 自定义主题之后，
         * 桌面这层的歌词只是「高亮那一段变了个色」，整行字还是那套灰白 ——
         * 而叠层（WebView 那层）读的是 App 整份主题，主色次色都跟着换，
         * 两边摆在一起就是「桌面歌词没有 AI 主题的高亮色」（用户原话）。
         *
         * 现在跟叠层一样去读 `WallpaperThemePalette` 那份（主 WebView 下发的
         * primaryColor / secondaryColor）。没有（旧包 / 还没下发）时回落原来那对灰白，
         * 行为不变。
         */
        private val FALLBACK_PRIMARY: Int = 0xFF9EA8B8.toInt()
        private val FALLBACK_SECONDARY: Int = 0xFFB3BDD1.toInt()

        /**
         * 交叉淡出的时长。
         *
         * 700ms：短到换歌时不会有「上一首还挂着」的错觉，长到 30fps 下有二十来帧渐变
         * （待机 10fps 也有七帧），肉眼看是融化而不是台阶。再长就和「换歌」这个动作脱节了。
         */
        private const val COVER_FADE_SECONDS = 0.7f

        /** 两帧之间最少隔多久（纳秒）：30fps。 */
        private const val FRAME_INTERVAL_NS = 33_000_000L
        /**
         * 待机（没歌、没歌词）时的帧间隔：10fps。
         *
         * 那会儿画面上只有一层慢慢流动的背景，按播放时的 30fps 画纯属白烧电 ——
         * 桌面停留的时间可比播放时长得多。
         */
        private const val IDLE_FRAME_INTERVAL_NS = 100_000_000L

        /** 颜色串可能来自 App 的任意一处：解析不了就回落，别把整层渲染拖挂。 */
        private fun safeParseColor(value: String?, fallback: Int): Int {
            if (value == null || value.isEmpty()) return fallback
            try {
                return android.graphics.Color.parseColor(value)
            } catch (error: Throwable) {
                return fallback
            }
        }

        /**
         * 逐字测量：返回每个字在位图上的右边界（长度 = 字数 + 1，第 0 个是左 padding）。
         *
         * 按**码点**切而不是按 char —— 表情是代理对，按 char 切会把一个表情切成两半，
         * 逐字上浮时那半边就会单独飘出去。
         */
        private fun measureCharBounds(text: String, paint: Paint, pad: Int): FloatArray {
            val count = text.codePointCount(0, text.length)
            val bounds = FloatArray(count + 1)
            var x = pad.toFloat()
            var index = 1
            bounds[0] = pad.toFloat()
            var offset = 0
            while (offset < text.length) {
                val codePoint = text.codePointAt(offset)
                val next = offset + Character.charCount(codePoint)
                // 带整串上下文地量：单独 measure 一个字符拿不到连写/字距调整后的宽度。
                x += paint.measureText(text, offset, next)
                if (index < bounds.size) {
                    bounds[index] = x
                }
                index++
                offset = next
            }
            return bounds
        }

        private fun decodeCover(base64: String): Bitmap? {
            try {
                val comma = base64.indexOf(',')
                val payload = if (comma >= 0) base64.substring(comma + 1) else base64
                val bytes = android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
                val source = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (source == null || source.width < 2 || source.height < 2) {
                    return null
                }
                // 封面可能很大，先压到 768 再模糊，避免上传一张几千像素的纹理。
                // 768 而不是 512：模糊滑杆拉到 0 时这张图就是画面本身，512 在全屏上偏软。
                val edge = Math.max(source.width, source.height)
                if (edge > 768) {
                    val ratio = 768f / edge
                    val scaled = Bitmap.createScaledBitmap(source,
                            Math.round(source.width * ratio),
                            Math.round(source.height * ratio), true)
                    source.recycle()
                    return scaled
                }
                return source
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to decode the wallpaper cover", error)
                return null
            }
        }

        private fun upload(bitmap: Bitmap): Int {
            val ids = IntArray(1)
            GLES20.glGenTextures(1, ids, 0)
            if (ids[0] == 0) {
                return 0
            }
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
            return ids[0]
        }

        /** 高斯模糊的工作尺寸上限。模糊后已无高频，再放大回全屏也不会出块。 */
        private const val BLUR_WORK_EDGE = 768
        /** amount=1 时的 σ，按工作图短边的比例算。 */
        private const val BLUR_MAX_SIGMA_RATIO = 0.075f

        /**
         * 高斯模糊。
         *
         * 注意「缩小再放大」**不是**模糊，那是降采样：缩到 200px 再放大回 1080，
         * 每个像素被摊成一个大方块，出来的就是马赛克 —— 这正是之前那版的做法。
         * 这里跑的是货真价实的高斯（见 gaussianBlur），缩到工作尺寸只是为了速度。
         *
         * 强度 amount∈[0,1] 映射到 σ（工作图上的像素数）：0 是一点不糊，1 约到短边的 7.5%。
         */
        @JvmStatic
        fun blurredCover(source: Bitmap, amount: Float): Bitmap {
            try {
                val a = clamp(amount, 0f, 1f)
                if (a <= 0.01f) return source
                val sw = source.width
                val sh = source.height
                if (sw < 2 || sh < 2) return source

                // 降到工作尺寸纯粹是为了速度。模糊之后的图已经不含高频分量，
                // 交给 GL 双线性放大回全屏时不会再出块 —— 出块的是「只缩不放」不是降采样本身。
                val scale = Math.min(1f, BLUR_WORK_EDGE / Math.max(sw, sh).toFloat())
                val w = Math.max(8, Math.round(sw * scale))
                val h = Math.max(8, Math.round(sh * scale))
                val work = if (w == sw && h == sh) source else Bitmap.createScaledBitmap(source, w, h, true)

                val sigma = a * BLUR_MAX_SIGMA_RATIO * Math.min(w, h)
                if (sigma < 0.5f) return work
                val blurred = gaussianBlur(work, sigma)
                if (work !== source) {
                    work.recycle()
                }
                return blurred
            } catch (error: Throwable) {
                Log.w(TAG, "Blur failed; using the raw cover", error)
                return source
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
        private fun gaussianBlur(source: Bitmap, sigma: Float): Bitmap {
            val w = source.width
            val h = source.height
            val pixels = IntArray(w * h)
            source.getPixels(pixels, 0, w, 0, 0, w, h)

            val boxes = boxesForGauss(sigma, 3)
            val channel = FloatArray(w * h)
            val temp = FloatArray(w * h)
            for (shift in CHANNEL_SHIFTS) {
                for (i in pixels.indices) {
                    channel[i] = ((pixels[i] shr shift) and 0xFF).toFloat()
                }
                for (pass in boxes.indices) {
                    boxBlur(channel, temp, w, h, (boxes[pass] - 1) / 2)
                }
                val keep = (0xFF shl shift).inv()
                for (i in pixels.indices) {
                    val value = Math.round(channel[i])
                    pixels[i] = (pixels[i] and keep) or (Math.min(255, Math.max(0, value)) shl shift)
                }
            }

            val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            out.setPixels(pixels, 0, w, 0, 0, w, h)
            return out
        }

        /** R / G / B 在 0xAARRGGBB 里的位移。 */
        private val CHANNEL_SHIFTS = intArrayOf(16, 8, 0)

        /** 一次可分离盒式模糊：横向一遍再纵向一遍，窗口宽度 2r+1。 */
        private fun boxBlur(source: FloatArray, temp: FloatArray, w: Int, h: Int, r: Int) {
            boxBlurHorizontal(source, temp, w, h, r)
            boxBlurVertical(temp, source, w, h, r)
        }

        private fun boxBlurHorizontal(source: FloatArray, target: FloatArray, w: Int, h: Int, r: Int) {
            val scale = 1f / (r + r + 1)
            for (y in 0 until h) {
                val row = y * w
                // 左边界外按「重复边缘像素」处理：窗口里 x<0 的那些格都算作 source[0]。
                var acc = source[row] * (r + 1)
                for (x in 1..r) acc += source[row + Math.min(x, w - 1)]
                for (x in 0 until w) {
                    target[row + x] = acc * scale
                    acc += source[row + Math.min(x + r + 1, w - 1)] - source[row + Math.max(x - r, 0)]
                }
            }
        }

        private fun boxBlurVertical(source: FloatArray, target: FloatArray, w: Int, h: Int, r: Int) {
            val scale = 1f / (r + r + 1)
            for (x in 0 until w) {
                var acc = source[x] * (r + 1)
                for (y in 1..r) acc += source[Math.min(y, h - 1) * w + x]
                for (y in 0 until h) {
                    target[y * w + x] = acc * scale
                    acc += source[Math.min(y + r + 1, h - 1) * w + x] - source[Math.max(y - r, 0) * w + x]
                }
            }
        }

        /**
         * 把 σ 拆成 n 个盒式窗口的宽度。
         *
         * 单个盒式模糊是方波，两个叠起来是三角波，三个已经非常接近钟形。
         * 公式来自「n 个宽度 w 的盒式模糊 ≈ σ 的高斯」这个等价关系的解析解。
         */
        private fun boxesForGauss(sigma: Float, n: Int): IntArray {
            val ideal = Math.sqrt((12 * sigma * sigma / n + 1).toDouble()).toFloat()
            var smaller = Math.floor(ideal.toDouble()).toInt()
            if (smaller % 2 == 0) smaller--
            if (smaller < 1) smaller = 1
            val larger = smaller + 2
            /*
             * 除号必须留在上一行行尾：Kotlin 2.3 会把握手行首的斜杠读成注释开头，
             * 于是后面整段都被当成注释吞掉，报的是语法错误而不是运算符问题。
             */
            val mIdeal = (12 * sigma * sigma - n * smaller * smaller - 4 * n * smaller - 3 * n) /
                    (-4 * smaller - 4)
            val m = Math.round(mIdeal)
            val sizes = IntArray(n)
            for (i in 0 until n) {
                sizes[i] = if (i < m) smaller else larger
            }
            return sizes
        }

        /**
         * 把主题色抬到「压在深浅不定的底图上也看得清」的程度。
         *
         * **不强行加饱和度。** 早先从封面取色时会把饱和度硬拉到 0.42 以上，那对偏暗的封面主色
         * 是必要的；可主题色本身已经挑过可读性了，再拉一次就是把 #f4f4f5 这种近白的高亮色
         * 变成粉红 —— 那是凭空造色，不是跟着主题。所以只动明度：过暗的抬一点，让它不至于
         * 在深色底图上消失；本来够亮的几乎不动。
         */
        private fun liftForText(hsv: FloatArray): FloatArray {
            return floatArrayOf(
                    hsv[0],
                    hsv[1],
                    Math.min(1f, Math.max(0.62f, hsv[2] * 0.5f + 0.5f)))
        }

        private fun rgbOfHsv(hsv: FloatArray): FloatArray {
            val rgb = Color.HSVToColor(hsv)
            return floatArrayOf(
                    ((rgb shr 16) and 0xFF) / 255f,
                    ((rgb shr 8) and 0xFF) / 255f,
                    (rgb and 0xFF) / 255f)
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
        private fun tintsFromTheme(accentRgb: FloatArray): Array<FloatArray> {
            val hsv = FloatArray(3)
            Color.RGBToHSV(
                    Math.round(clamp(accentRgb[0], 0f, 1f) * 255f),
                    Math.round(clamp(accentRgb[1], 0f, 1f) * 255f),
                    Math.round(clamp(accentRgb[2], 0f, 1f) * 255f),
                    hsv)
            val first = liftForText(hsv)
            val second = liftForText(floatArrayOf((hsv[0] + 0.085f) % 1f, hsv[1], hsv[2]))
            return arrayOf(first, second)
        }

        /** 1×1 白色纹理：纯色矩形（轨道 / 进度条）也要绑一张纹理才能走同一个着色器。 */
        private fun createSolidTexture(): Int {
            val bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            val texture = upload(bitmap)
            bitmap.recycle()
            return texture
        }

        private fun buildProgram(vertexSource: String, fragmentSource: String): Int {
            val vertexShader = compile(GLES20.GL_VERTEX_SHADER, vertexSource)
            val fragmentShader = compile(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
            if (vertexShader == 0 || fragmentShader == 0) {
                return 0
            }
            val program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, vertexShader)
            GLES20.glAttachShader(program, fragmentShader)
            GLES20.glLinkProgram(program)
            val linked = IntArray(1)
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0)
            if (linked[0] == 0) {
                Log.e(TAG, "Link failed: " + GLES20.glGetProgramInfoLog(program))
                GLES20.glDeleteProgram(program)
                return 0
            }
            GLES20.glDeleteShader(vertexShader)
            GLES20.glDeleteShader(fragmentShader)
            return program
        }

        private fun compile(type: Int, source: String): Int {
            val shader = GLES20.glCreateShader(type)
            GLES20.glShaderSource(shader, source)
            GLES20.glCompileShader(shader)
            val compiled = IntArray(1)
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
            if (compiled[0] == 0) {
                Log.e(TAG, "Shader compile failed: " + GLES20.glGetShaderInfoLog(shader))
                GLES20.glDeleteShader(shader)
                return 0
            }
            return shader
        }

        private fun approach(value: Float, target: Float, deltaSeconds: Float, speed: Float): Float {
            val factor = 1f - Math.exp((-deltaSeconds * speed).toDouble()).toFloat()
            return value + (target - value) * factor
        }

        private fun clamp(value: Float, min: Float, max: Float): Float {
            return Math.max(min, Math.min(max, value))
        }

        /** 缓出：快进慢收。用于换行走入，落位那一下不会有「顿」感。 */
        private fun easeOutCubic(t: Float): Float {
            val v = clamp(t, 0f, 1f)
            val inv = 1f - v
            return 1f - inv * inv * inv
        }

        private fun rgbFromColor(color: Int): FloatArray {
            return floatArrayOf(
                    ((color shr 16) and 0xFF) / 255f,
                    ((color shr 8) and 0xFF) / 255f,
                    (color and 0xFF) / 255f)
        }

        // ---- 着色器 ----

        private const val BACKGROUND_VERTEX =
                "attribute vec2 aPosition;\n" +
                "attribute vec2 aUv;\n" +
                "uniform vec4 uRect;\n" +
                "varying vec2 vUv;\n" +
                "void main() {\n" +
                "  vUv = aUv;\n" +
                "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n" +
                "  gl_Position = vec4(ndc, 0.0, 1.0);\n" +
                "}\n"

        private const val BACKGROUND_FRAGMENT =
                "precision mediump float;\n" +
                "varying vec2 vUv;\n" +
                "uniform float uTime;\n" +
                "uniform float uAspect;\n" +
                "uniform float uOffsetX;\n" +
                "uniform vec3 uAccent;\n" +
                "uniform vec3 uBase;\n" +
                "uniform float uMotion;\n" +
                "uniform float uBlob;\n" +
                "uniform float uDust;\n" +
                "uniform float uGlow;\n" +
                "uniform float uPpGrain;\n" +
                "uniform float uPpContrast;\n" +
                "uniform float uPpVignette;\n" +
                "void main() {\n" +
                "  vec2 p = vec2(vUv.x * uAspect, vUv.y);\n" +
                "  float t = uTime * 0.06 * uMotion;\n" +
                "  vec2 c1 = vec2((0.30 + 0.12 * sin(t * 1.1) + uOffsetX * 0.12) * uAspect," +
                " 0.26 + 0.10 * cos(t * 0.9));\n" +
                "  vec2 c2 = vec2((0.72 + 0.10 * cos(t * 0.8) + uOffsetX * 0.12) * uAspect," +
                " 0.72 + 0.12 * sin(t * 1.3));\n" +
                "  float g1 = smoothstep(0.95 * uBlob, 0.0, distance(p, c1));\n" +
                "  float g2 = smoothstep(0.95 * uBlob, 0.0, distance(p, c2));\n" +
                "  vec3 col = uBase + uAccent * (g1 * 0.42 + g2 * 0.28) * uGlow;\n" +
                // 缓慢上浮的细颗粒，给静止的画面一点呼吸感。
                "  float dust = 0.0;\n" +
                "  for (int i = 0; i < 8; i++) {\n" +
                "    float fi = float(i);\n" +
                "    float speed = (0.020 + 0.008 * fi) * uMotion;\n" +
                "    float x = fract(0.137 * fi + 0.05 * sin(uTime * 0.35 + fi));\n" +
                "    float y = fract(0.913 - mod(uTime * speed + 0.171 * fi, 1.0));\n" +
                "    float r = 0.004 + 0.006 * fract(fi * 0.371);\n" +
                "    dust += smoothstep(r, 0.0, distance(p, vec2(x * uAspect, y)));\n" +
                "  }\n" +
                "  col += vec3(0.55, 0.58, 0.68) * dust * 0.16 * uDust;\n" +
                "  float vignette = smoothstep(1.25, 0.30, distance(vUv, vec2(0.5)));\n" +
                "  float vig = mix(0.52, 1.0, vignette);\n" +
                // postProcessVignette 超过基准档(0.85)的部分继续压暗：二次曲线比线性更像真镜头。
                "  vig *= mix(1.0, vig, clamp((uPpVignette - 0.85) / 1.15, 0.0, 1.0));\n" +
                // 传 -1 表示应用侧关掉了暗角：整条压暗都不做，边缘不再收黑。
                "  vig = mix(vig, 1.0, step(uPpVignette, -0.5));\n" +
                "  col *= vig;\n" +
                // 胶片颗粒：一层与时间相关的白噪声。这是实验台里 postProcessGrain 的原生等价物。
                "  if (uPpGrain > 0.001) {\n" +
                "    float grain = fract(sin(dot(p * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);\n" +
                "    col += (grain - 0.5) * uPpGrain * 0.28;\n" +
                "  }\n" +
                // 对比度：绕中灰拉伸。postProcessContrast 反过来("-1")也能用，只是会压平。
                "  col = clamp((col - 0.5) * (1.0 + uPpContrast) + 0.5, 0.0, 1.0);\n" +
                "  gl_FragColor = vec4(col, 1.0);\n" +
                "}\n"

        private const val QUAD_VERTEX =
                "attribute vec2 aPosition;\n" +
                "attribute vec2 aUv;\n" +
                "uniform vec4 uRect;\n" +
                // 只采样纹理里的一小块（逐字上浮按字切 UV）。整行绘制时传 (0,0,1,1)。
                "uniform vec4 uUvRect;\n" +
                "varying vec2 vUv;\n" +
                "void main() {\n" +
                // 位图第 0 行在顶部，纹理坐标 v=0 在底部，所以要翻过来。
                "  vUv = vec2(uUvRect.x + aUv.x * uUvRect.z,\n" +
                "             1.0 - (uUvRect.y + aUv.y * uUvRect.w));\n" +
                "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n" +
                "  gl_Position = vec4(ndc, 0.0, 1.0);\n" +
                "}\n"

        private const val QUAD_FRAGMENT =
                "precision mediump float;\n" +
                "varying vec2 vUv;\n" +
                "uniform sampler2D uTexture;\n" +
                "uniform vec3 uColor;\n" +
                "uniform vec3 uActive;\n" +
                "uniform vec3 uActive2;\n" +
                "uniform vec3 uGlow;\n" +
                "uniform float uAlpha;\n" +
                "uniform float uProgress;\n" +
                "uniform float uWholeLine;\n" +
                "uniform float uUseTexColor;\n" +
                "void main() {\n" +
                "  vec4 tex = texture2D(uTexture, vUv);\n" +
                "  float a = tex.a * uAlpha;\n" +
                "  vec3 rgb = mix(uColor, tex.rgb, uUseTexColor);\n" +
                "  if (uProgress >= 0.0) {\n" +
                // 整行模式：整行铺满渐变，进度只把亮度从「压暗」推到「满色」。
                // 没有横向擦除，所以不存在「一个字一个字亮起来 / 浮起来」的观感。
                "    if (uWholeLine > 0.5) {\n" +
                "      vec3 g2 = mix(uActive, uActive2, clamp(vUv.x, 0.0, 1.0));\n" +
                "      vec3 d2 = mix(uColor, g2, 0.22);\n" +
                "      rgb = mix(d2, g2, clamp(uProgress, 0.0, 1.0));\n" +
                "    } else {\n" +
                "    float edge = smoothstep(uProgress - 0.010, uProgress + 0.010, vUv.x);\n" +
                // 渐变铺满**整行**：沿行方向在 uActive → uActive2 之间插值，两端色取自当前主题。
                // 唱过的那一段用满饱和的渐变，没唱到的用同一条渐变压暗 ——
                // 这是状态栏歌词那类插件的通行做法：整行先有颜色，进度再把亮度推上去，
                // 而不是「白字 + 一小块彩色高亮」。
                "    vec3 grad = mix(uActive, uActive2, clamp(vUv.x, 0.0, 1.0));\n" +
                "    vec3 dim = mix(uColor, grad, 0.20);\n" +
                "    rgb = mix(grad, dim, edge);\n" +
                "    float glow = exp(-pow((vUv.x - uProgress) * 26.0, 2.0));\n" +
                "    rgb += uGlow * glow * 0.95;\n" +
                "    }\n" +
                "  }\n" +
                // 位图是预乘 alpha 的，这里按预乘输出，配合 blendFunc(ONE, 1-SRC_ALPHA)。
                "  gl_FragColor = vec4(rgb * a, a);\n" +
                "}\n"

        /*
         * 视频那一套：顶点照旧，采样换成了 samplerExternalOES。
         *
         * **这里不能自己翻 Y。**
         *
         * 图片（普通 2D 纹理）那套着色器里有 `1.0 - ...`，那是为了补偿 Bitmap 的行序；
         * 而 SurfaceTexture 的 `getTransformMatrix()` 给出的矩阵**本身就包含那一次翻转** ——
         * 于是「自己翻一次 + 矩阵再翻一次」= 画面上下颠倒。这正是视频背景倒过来的原因。
         *
         * 官方的写法（Grafika 的 Texture2dProgram、Camera2/ExoPlayer 的 Surface 渲染）都是：
         * quad 的 UV (0,0) 落在**左下角**（与 aPosition 一致），直接乘矩阵，不做任何预处理。
         * 我们的 unit quad 正是这个约定（aPosition.y=0 在屏幕下边，aUv.y=0 配着它）。
         *
         * cover 裁剪（uUvRect）是**居中**的，上下左右对称，所以它在哪一头的坐标系里
         * 量都一样，不需要为它再做方向调整。
         */
        private const val VIDEO_VERTEX =
                "attribute vec2 aPosition;\n" +
                "attribute vec2 aUv;\n" +
                "uniform vec4 uRect;\n" +
                "uniform vec4 uUvRect;\n" +
                "uniform mat4 uTexMatrix;\n" +
                "varying vec2 vUv;\n" +
                "void main() {\n" +
                "  vec2 uv = vec2(uUvRect.x + aUv.x * uUvRect.z,\n" +
                "                 uUvRect.y + aUv.y * uUvRect.w);\n" +
                "  vUv = (uTexMatrix * vec4(uv, 0.0, 1.0)).xy;\n" +
                "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n" +
                "  gl_Position = vec4(ndc, 0.0, 1.0);\n" +
                "}\n"

        /**
         * 注意 `#extension` 必须是整个片元着色器的第一行：写在 precision 或任何语句之后，
         * 有的驱动会直接编译失败（表现为视频模式一片黑，日志里只有一句 compile failed）。
         */
        private const val VIDEO_FRAGMENT =
                "#extension GL_OES_EGL_image_external : require\n" +
                "precision mediump float;\n" +
                "uniform samplerExternalOES uTexture;\n" +
                "uniform float uDim;\n" +
                "varying vec2 vUv;\n" +
                "void main() {\n" +
                "  vec3 rgb = texture2D(uTexture, vUv).rgb;\n" +
                // 视频是不透明的整屏画面，不需要参与混合。
                "  gl_FragColor = vec4(rgb * (1.0 - uDim), 1.0);\n" +
                "}\n"
    }

    private var surfaceWidth = 1
    private var surfaceHeight = 1
    /** 壁纸横向偏移（桌面左右滑页时系统会回调），用来让背景跟着轻微视差。 */
    @Volatile
    private var offsetX = 0f
    /** 已上传的封面对应的 base64。壁纸可能比应用晚启动，所以只能靠比对来发现新封面。 */
    private var loadedCoverKey: String? = null

    private var backgroundProgram = 0
    private var quadProgram = 0
    /** 视频背景那一套（OES 外部纹理），见 drawVideo。 */
    private var videoProgram = 0
    private var quadBuffer = 0

    private var accent = floatArrayOf(0.49f, 0.36f, 1.0f)
    private var accentTarget = floatArrayOf(0.49f, 0.36f, 1.0f)
    private val primary = floatArrayOf(0.62f, 0.66f, 0.72f)
    private var primaryTarget = floatArrayOf(0.62f, 0.66f, 0.72f)
    private val secondary = floatArrayOf(0.70f, 0.74f, 0.82f)
    private var secondaryTarget = floatArrayOf(0.70f, 0.74f, 0.82f)
    /** 上一次解析过的颜色串。变了才重新 parse —— 字符串解析不该每帧走一遍。 */
    private var palettePrimary: String? = null
    private var paletteSecondary: String? = null
    /*
     * AI 主题给**指定词**上的色（主题的 `wordColors`）。
     *
     * 这才是「AI 主题的效果」最显眼的那一块：生成 AI 主题时，模型会把歌词里有情绪的
     * 那几个词各挑一个颜色，播放页画到那些字时**换成那个颜色**。这一层是原生 GLES
     * 自绘的，原来只认「主文本色 + 高亮色」两个颜色，主题里的 wordColors 一个都没看，
     * 于是 App 里换成 AI 主题之后桌面这层纹丝不动 —— 也就是用户说的
     * 「AI 主题的高亮色没有」。
     *
     * 匹配规则复用悬浮小窗那一套（FloatingWordColors），同一个词在两边才会是同一个颜色。
     */
    private var wordRules: Array<FloatingWordColors.Rule> = FloatingWordColors.EMPTY
    /** 解析 wordRules 时用的那份 JSON，用来判断主题换没换。 */
    private var wordThemeJson: String? = null
    /** 上一次为哪一行摊过逐字颜色（见 charColorsFor）。 */
    private var charColorLine: WallpaperLyricsState.TimedLine? = null
    /** 那一次用的规则表：同一行但主题换过也要重算。 */
    private var charColorRules: Array<FloatingWordColors.Rule>? = null
    /** 行文本每个字符位置的颜色；NO_COLOR = 这个位置没被标色。 */
    private var charColors: IntArray? = null
    /** endpointFor 的返回值容器：逐字画时每个字都要取一次，别每次新建数组。 */
    private val wordEndpoint = FloatArray(3)
    /*
     * 歌词那条**渐变**的两个端点。
     *
     * 整行歌词的颜色几乎全由这一对决定（见 QUAD_FRAGMENT：`grad` 铺满整行，
     * `uColor` 只掺 20%），而它们原来传的是 `coverTint` —— 那是从 `accent`
     * 用 HSV 派生出来的一对**假色**（tintsFromTheme）。于是 App 换成 AI / 自定义主题后，
     * 桌面这层还是照着 accent 自己算一条渐变出来，主题真正的配色一个字没参与：
     * 用户看到的就是「整行被一层主题渐变盖住了，AI 主题的高亮色没有」。
     *
     * 这一对改用主题**自己的**真值：高亮色（accent）+ 主文本色（palette 那份）。
     * 没有 palette（旧包 / 还没下发）时回落原来那套从 accent 派生的渐变，观感不变。
     */
    private val lyricTint = floatArrayOf(0.62f, 0.66f, 0.72f)
    private var lyricTintTarget = floatArrayOf(0.62f, 0.66f, 0.72f)
    private val lyricTint2 = floatArrayOf(0.70f, 0.74f, 0.82f)
    private var lyricTint2Target = floatArrayOf(0.70f, 0.74f, 0.82f)
    /** 与 App 当前主题一致的底色与动效强度。 */
    private var base = floatArrayOf(0.035f, 0.035f, 0.043f)
    private var baseTarget = floatArrayOf(0.035f, 0.035f, 0.043f)
    private var motion = 1f
    private var motionTarget = 1f
    /** 背景模糊强度 0..1。 */
    private var blurAmount: Float = WallpaperLyricsState.DEFAULT_BLUR
    /**
     * 歌词高亮的两个渐变端点色，取自**当前主题**。
     *
     * 早先是从封面按色相分桶取主色：想法不错，但封面主色常常偏暗偏灰，提亮之后
     * 仍然和界面上的配色不搭 —— 壁纸和 App 用两套色，看着就不像一个应用。
     * 现在直接跟着主题走，主题换了端点色就换。
     */
    private var coverTint = floatArrayOf(1f, 1f, 1f)
    private var coverTintTarget = floatArrayOf(1f, 1f, 1f)
    private var coverTint2 = floatArrayOf(1f, 1f, 1f)
    private var coverTint2Target = floatArrayOf(1f, 1f, 1f)
    /** 1×1 白色纹理：轨道、进度条这类纯色矩形要用它（着色器总要绑一张纹理）。 */
    private var solidTexture = 0

    private var animatedIndex = 0f
    private var animatedProgress = 0f
    /**
     * 播放 UI（歌词 + 进度条）的整体淡入淡出系数 0..1。
     *
     * 暂停时（wp.hideWhenPaused 开着）与心跳断掉时都趋向 0 —— 但**带动画**，
     * 不是突然消失（用户原话：隐藏加动画不要突然消失，心跳隐藏也是）。
     * 每帧朝目标平滑逼近（见 onDrawFrame），画歌词 / 进度条时把 alpha 乘上它。
     */
    private var uiAlpha = 1f
    /**
     * 换行走入：新的一句成为焦点时的滑入进度 0..1（1 = 已经站定）。
     * 这是原生层唯一「额外」的动画 —— 去掉线条背景之后画面太静，加这一点点就够。
     */
    private var lineEnter = 1f
    private var lastComputedIndex = -1
    private var lastNanos = 0L
    private var elapsedSeconds = 0f

    private var coverTexture = 0
    /** 上图时记下位图尺寸，铺满时按它算 cover 比例，别把图拉变形。 */
    private var coverWidth = 0
    private var coverHeight = 0
    /**
     * 上一张封面：换图时先留着它做交叉淡出，而不是马上删纹理。
     *
     * 原来是在 syncCover 里直接 `glDeleteTextures` + 上传新的：那一帧还是旧图、下一帧
     * 已经是新图，中间没有任何过渡。封面这层虽然只有 0.28 的不透明度，可它是**整屏**
     * 一层，换歌那一瞬整块底色会硬切一下（用户原话：突然一闪而过）。而同一帧里
     * 主题色是缓慢插值过去的（见 coverTint），一个渐变一个硬切，看着更突兀。
     *
     * 换歌时封面是**两步到位**的：先 publish 一次（cover 为 null，状态里保留上一张），
     * 等 Web 层把图抓完转成 base64 再 publish 一次 —— 中间隔着几百毫秒，
     * 所以这一次切换几乎必定发生在「桌面正看着」的时候，过渡必须做。
     */
    private var coverPrevTexture = 0
    private var coverPrevWidth = 0
    private var coverPrevHeight = 0
    /** 这次交叉淡出从什么时候开始（System.nanoTime）。 */
    private var coverFadeStartNanos = 0L

    /** 自选背景图。与封面分开存，换歌时不该被顶掉。 */
    private var imageTexture = 0
    private var imageWidth = 0
    private var imageHeight = 0
    private var loadedImageKey: String? = null

    // ---- 视频背景（mode=video）----
    /**
     * 视频帧走的是 `GL_TEXTURE_EXTERNAL_OES`：SurfaceTexture 只肯往这种纹理上写，
     * 拿不到 2D 纹理。所以它有自己那套 program（samplerExternalOES），
     * 不能复用画位图的 quadProgram。
     */
    private var videoTexture = 0
    private var videoSurfaceTexture: SurfaceTexture? = null
    private var videoSurface: Surface? = null
    private var videoPlayer: MediaPlayer? = null
    private var loadedVideoKey: String? = null
    private var videoWidth = 0
    private var videoHeight = 0
    /** SurfaceTexture 给的采样变换（含 Y 轴翻转），每帧跟着 updateTexImage 一起取。 */
    private val videoTransform = FloatArray(16)
    /** 壁纸不可见时把解码器也停掉：视频本身很耗电，没必要在黑屏后面继续解。 */
    private var _videoActive = true

    private var style: Style = LYRICS_STYLE
    /** 歌词动画实验台里当前生效那个模式的配置（扁平键值表，见 WallpaperLyricsState.tuning）。 */
    private var tuning: Map<String, Float> = java.util.Collections.emptyMap()
    /** 当前模式字面量。有些开关只有某个模式才有，得按模式决定要不要读默认值。 */
    private var activeMode: String = "sonnet"
    /** 当前歌词字体；null 表示还没有从磁盘读过或上次读出来是坏文件。 */
    private var loadedFontKey: String? = null
    private var activeTypeface: Typeface? = null

    /** 封面纹理只在 mode=cover 时需要；切到别的模式就释放掉。 */
    private fun releaseCover() {
        if (coverTexture != 0) {
            GLES20.glDeleteTextures(1, intArrayOf(coverTexture), 0)
            coverTexture = 0
        }
    }

    /** 释放正在淡出的那张旧封面（只在 GL 线程里调，且必须在淡完之后）。 */
    private fun releaseCoverPrev() {
        if (coverPrevTexture != 0) {
            GLES20.glDeleteTextures(1, intArrayOf(coverPrevTexture), 0)
            coverPrevTexture = 0
        }
        coverPrevWidth = 0
        coverPrevHeight = 0
    }

    private fun releaseImage() {
        if (imageTexture != 0) {
            GLES20.glDeleteTextures(1, intArrayOf(imageTexture), 0)
            imageTexture = 0
        }
    }

    /** key = 文本 + '@' + 字号，value = 已上传的纹理。插入顺序即淘汰顺序。 */
    private val textures: LinkedHashMap<String, TextTexture> =
            object : LinkedHashMap<String, TextTexture>(TEXTURE_CACHE_LIMIT, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, TextTexture>): Boolean {
                    if (size <= TEXTURE_CACHE_LIMIT) {
                        return false
                    }
                    eldest.value.dispose()
                    return true
                }
            }

    fun setOffsets(xOffset: Float) {
        this.offsetX = xOffset
    }


    override fun onSurfaceCreated(gl: GL10, config: EGLConfig) {
        backgroundProgram = buildProgram(BACKGROUND_VERTEX, BACKGROUND_FRAGMENT)
        quadProgram = buildProgram(QUAD_VERTEX, QUAD_FRAGMENT)
        videoProgram = buildProgram(VIDEO_VERTEX, VIDEO_FRAGMENT)
        quadBuffer = createUnitQuad()
        solidTexture = createSolidTexture()
        /*
         * GL 上下文是全新的：上一轮的 OES 纹理和 Surface 全部失效，
         * 播放器也留不住（它抱着的正是那个旧 Surface）。清干净并让它重新起一份 ——
         * key 置空，下一帧 syncVideo 就会照着磁盘上那个文件重新 prepare。
         */
        loadedVideoKey = null
        releaseVideoResources()
        /*
         * 封面那几张位图纹理同样没了（旧 id 在新上下文里是非法的，拿去画就是垃圾）。
         * 置 0 之后下一帧 syncCover 会重新上传 —— key 也一并清掉，否则它会以为图还在。
         */
        coverTexture = 0
        coverPrevTexture = 0
        loadedCoverKey = null
        imageTexture = 0
        loadedImageKey = null
        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glEnable(GLES20.GL_BLEND)
        // 位图纹理是预乘 alpha 的（Android Bitmap 的存储格式如此），
        // 因此用 ONE 而不是 SRC_ALPHA，否则字的边缘会被二次相乘、发灰。
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    }

    override fun onSurfaceChanged(gl: GL10, width: Int, height: Int) {
        surfaceWidth = Math.max(1, width)
        surfaceHeight = Math.max(1, height)
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
        textures.clear()
    }

    private var lastFrameNanos = 0L

    /** 把渲染节奏按到 30fps（待机时 10fps）；见 onDrawFrame 里的说明。 */
    private fun throttleFrameRate(idle: Boolean) {
        val interval = if (idle) IDLE_FRAME_INTERVAL_NS else FRAME_INTERVAL_NS
        if (lastFrameNanos == 0L) {
            lastFrameNanos = System.nanoTime()
            return
        }
        val target = lastFrameNanos + interval
        val now = System.nanoTime()
        if (now >= target) {
            lastFrameNanos = now
            return
        }
        val remainingMillis = (target - now) / 1_000_000L
        if (remainingMillis <= 0L) {
            lastFrameNanos = now
            return
        }
        try {
            Thread.sleep(remainingMillis, ((target - now) % 1_000_000L).toInt())
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        lastFrameNanos = System.nanoTime()
    }

    override fun onDrawFrame(gl: GL10) {
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
        val snapshot = WallpaperLyricsState.get()
        /*
         * **没有歌词时不能整帧 return。**
         *
         * 早先这里有一条 `if (snapshot.isEmpty()) return;`，结果是没播放、冷启动、纯待机时
         * 一帧都不画 —— 桌面壁纸直接是空的（保持住上一次的内容，或者干脆黑掉一块）。
         * 而下面那套 IDLE_* 待机配色正是为了这个状态写的，被这条早退挡着从来没生效过。
         * 空状态照样要铺背景，只是不必按播放时的帧率画，所以把 idle 交给节流。
         */
        val idle = snapshot.isEmpty()
        throttleFrameRate(idle)
        val now = System.nanoTime()
        val deltaSeconds = if (lastNanos == 0L) 0.016f else Math.min(0.1f, (now - lastNanos) / 1e9f)
        lastNanos = now
        elapsedSeconds += deltaSeconds

        // 当前行由原生按墙钟从时间轴算出来，不依赖 JS 推送 ——
        // 应用退到后台后 WebView 的定时器会被挂起，靠 JS 推「当前行」歌词就走不动了。
        val position = snapshot.positionMs()
        val computedIndex = snapshot.indexAt(position)
        val computedProgress = snapshot.progressAt(position)

        activeMode = snapshot.visualizerMode
        // style / tuning 必须在这之前落地：下面的行插值要看 enableTransitions，
        // 后面的背景与歌词绘制也要看这两个。
        style = styleFor(activeMode)
        tuning = WallpaperLyricsState.tuning()

        /*
         * **行内进度在换行那一瞬必须直接对齐，不能插值。**
         *
         * 换行时 computedProgress 是从 1 跳回 0 的（新行从头唱），而 animatedIndex 还要
         * 花几百毫秒才滑到新行 —— 这段重叠期里「上一行」仍然是焦点行。若进度也跟着
         * 平滑回落，上一行已经浮起来的字就会被一路拉回原位（**突然下浮**），
         * 等新行接手再从原位浮起来（**然后再上浮**）。用户报的就是这一下。
         * 所以：同一行内正常平滑，换行这一刻直接对齐。
         */
        val lineChanged = lastComputedIndex >= 0 && computedIndex != lastComputedIndex
        if (lineChanged) {
            animatedProgress = computedProgress
        } else {
            animatedProgress = approach(animatedProgress, computedProgress, deltaSeconds, 6f)
        }
        val targetIndex = computedIndex.toFloat()
        // enableTransitions 关掉时（以及换歌、拖动进度条这类大跳）直接对齐，不要缓慢地滑过去。
        if (!tb("enableTransitions", true) || Math.abs(targetIndex - animatedIndex) > 2.5f) {
            animatedIndex = targetIndex
            animatedProgress = computedProgress
            // 大跳不做走入动画：拖进度条时一堆行排队滑进来会像抽搐。
            lineEnter = 1f
        } else {
            animatedIndex = approach(animatedIndex, targetIndex, deltaSeconds, 7f)
            // 焦点换到新的一句：重新走一次滑入。
            if (lineChanged) {
                lineEnter = 0f
            }
        }
        lastComputedIndex = computedIndex
        lineEnter = Math.min(1f, lineEnter + deltaSeconds / LINE_ENTER_SECONDS)

        // 没歌（冷启动、纯待机）时别用那套「近乎全黑」的默认底色：
        // 空状态下背景只有一层极暗的底 + 很弱的光团，看上去就是一块黑屏。
        // 这里换一套能站得住的待机配色，让它至少像一张壁纸。
        accentTarget = rgbFromColor(if (idle) IDLE_ACCENT else snapshot.accent)
        baseTarget = rgbFromColor(if (idle) IDLE_BASE else snapshot.baseColor)
        motionTarget = if (idle) Math.max(0.6f, snapshot.motion) else snapshot.motion
        // 模糊强度改了要重新栅格化底图，所以单独比对：直接每帧重算的话一张 512 的位图
        // 每帧缩放两遍，代价太大。
        if (Math.abs(snapshot.blur - blurAmount) > 0.01f) {
            blurAmount = snapshot.blur
            loadedCoverKey = null
            loadedImageKey = null
        }
        // 文本主色 / 次色跟主题走（见 primary / secondary 字段上的那段）。
        syncThemePalette()
        // AI 主题给指定词上的色（见 wordRules 那段）。
        syncWordRules()
        /*
         * 歌词渐变的两端（见 lyricTint 那段）。
         *
         * 高亮端**恒取主题的高亮色**：它是跟着 publish 一起下来的（Snapshot.accent），
         * 不像主文本色那样要靠 Web 层额外下发那份 palette —— 依赖后者的话，那份缺席
         * 时整个退回 HSV 派生的假色，AI 主题等于白换。另一端用主文本色，那份没下发
         * 时退化成纯色，至少颜色本身是对的。
         *
         * 注意这里**不动** coverTint：那一对是给封面染色用的，换来源会把壁纸底图的
         * 配色也一起改掉 —— 那是另一件事，不该被歌词这边的修复捎上。
         */
        lyricTintTarget = accentTarget
        lyricTint2Target = if (palettePrimary == null) accentTarget else primaryTarget
        val blend = Math.min(1f, deltaSeconds * 3f)
        for (i in 0 until 3) {
            accent[i] += (accentTarget[i] - accent[i]) * blend
            base[i] += (baseTarget[i] - base[i]) * blend
            primary[i] += (primaryTarget[i] - primary[i]) * blend
            secondary[i] += (secondaryTarget[i] - secondary[i]) * blend
            lyricTint[i] += (lyricTintTarget[i] - lyricTint[i]) * blend
            lyricTint2[i] += (lyricTint2Target[i] - lyricTint2[i]) * blend
            coverTint[i] += (coverTintTarget[i] - coverTint[i]) * blend
            coverTint2[i] += (coverTint2Target[i] - coverTint2[i]) * blend
        }
        motion += (motionTarget - motion) * blend

        // 端点色只跟主题走：主题色本身可能由封面推导而来，但那是主题自己的事，
        // 壁纸这边不再单独去看封面 —— 两套取色逻辑只会画出两套对不上的颜色。
        val themeTints = tintsFromTheme(accentTarget)
        coverTintTarget = rgbOfHsv(themeTints[0])
        coverTint2Target = rgbOfHsv(themeTints[1])

        val useCover = "cover" == snapshot.backgroundMode
        val useImage = "image" == snapshot.backgroundMode
        val useVideo = "video" == snapshot.backgroundMode
        syncCover(if (useCover) snapshot.cover else null)
        syncImage(if (useImage) snapshot.image else null)
        // 视频不像图片那样从状态里拿内容：文件是原生自己拷的，自己读就行
        // （见 WallpaperBackgroundVideo 为什么必须拷一份）。
        syncVideo(useVideo)
        syncFont(snapshot.font)

        GLES20.glClearColor(0.02f, 0.02f, 0.03f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)

        // 选了图就只画「图 + 歌词」：用户要的就是那张图本身，
        // 再叠一层流动光晕和模糊封面反而把图盖掉了。图没就绪（读盘要一帧）时才走原来的渐变。
        val imageReady = useImage && imageTexture != 0
        // 视频自己就是一整屏画面，和自选图一样：不再叠渐变和模糊封面。
        // 还没起好（读盘 + prepare 要几帧）时先退回原来的画法，免得中间黑一下。
        val videoReady = useVideo && videoTexture != 0 && videoPlayer != null
        if (videoReady) {
            drawVideo()
        } else if (imageReady) {
            drawImage()
        } else {
            drawBackground()
            if (useCover) {
                drawCover()
            }
        }
        // 「跟随 + 叠层」时原生这层可以不画歌词/进度条：
        // 叠层跑的是播放页同一套可视化，自己也画歌词，两层叠在一起会重影。
        // 用 wp. 前缀的那两个开关控制，缺省照旧（画）。
        // 心跳断了就不画歌词和进度条：播放管线已经没了（应用被划掉后台 / WebView 死透），
        // 时间轴上走到的位置是没人听的。背景照画 —— 壁纸还得是一张壁纸。
        // 这里自己读心跳，不等别人转发（每个绘制入口都要自己读，见 WallpaperLyricsState）。
        //
        // ⭐ 暂停时**也收 UI**，而且两条路都带淡出动画（uiAlpha 平滑逼近，不许突然消失）：
        //   · 暂停：wp.hideWhenPaused（与叠层/小窗同一套开关）开着时收；
        //   · 心跳断：原来是一帧内直接停画 —— 观感就是「啪一下没了」，现在同样淡出。
        // 逼近速度 6（时间常数 ≈170ms）：约半秒淡完，快得跟手、慢得不突兀。
        val playbackAlive = WallpaperLyricsState.heartbeatAlive()
        val wantPlaybackUi = playbackAlive
                && (snapshot.playing || !tb("wp.hideWhenPaused", true))
        uiAlpha = approach(uiAlpha, if (wantPlaybackUi) 1f else 0f, deltaSeconds, 6f)
        val drawPlaybackUi = uiAlpha > 0.004f
        if (drawPlaybackUi && !tb("wp.hideNativeProgress", false)) {
            drawProgressBar(snapshot)
        }
        /*
         * 精简样式挂了「悬浮歌词小窗」时，壁纸这层也不画歌词。
         *
         * 那一颗小窗画的就是桌面简易那套歌词（见 FloatingLyricsOverlay）；壁纸自己
         * 还在中间画一整块的话，同一句会同时出现在两个地方 —— 扫光还不同步，看着像重影。
         * 背景照旧画：用户选的封面 / 渐变还在，中间空出来的那一块正好留给小窗。
         */
        if (drawPlaybackUi && !tb("wp.hideNativeLyrics", false) && !nativeLyricsShadowedByFloating()) {
            drawLyrics(snapshot)
        }
    }

    /**
     * 悬浮小窗是不是把壁纸这块歌词挡住了。
     *
     * 原来判据只有 `isShowing()` —— 小窗一挂，壁纸这边就整块停画。
     * 这在**普通**模式是对的：那颗小窗是屏幕中上部一个两行高的方块，
     * 正好压在壁纸画歌词的那一片上，两边同时画就是同一句出现两次、扫光还不同步
     * （用户看着就是重影）。
     *
     * 但**叠加安全区**那一路完全不是一回事：小窗只有状态栏那么高、贴在屏幕最顶上，
     * 而壁纸这块的歌词是以屏高 47% 为中心排的 —— 两者根本不重叠。
     * 那一路被一起停掉，用户看到的就是「开了个安全区，壁纸中间整块空了」
     * （用户原话：精简模式原生歌词也不显示）。
     *
     * 所以判据收紧成「小窗在显示**并且**它不是贴在安全区那一条上」。
     */
    private fun nativeLyricsShadowedByFloating(): Boolean {
        // context 标可空（applicationContext 理论上不返回 null，但类型上可空）；
        // 没拿到就当「没有叠层」，走原生绘制。
        val ctx = context ?: return false
        val overlay = FloatingLyricsOverlay.shared(ctx)
        return overlay.isShowing() && !overlay.isOverSafeArea()
    }

    /**
     * 读主 WebView 下发下来的文本主色 / 次色（见 primary / secondary 字段上那段）。
     *
     * 只在这两个**字符串**变了的时候才 parse：这里的 update 是每帧跑的，
     * 而 `Color.parseColor` 是字符串解析 —— 每帧解析两遍纯属白烧。
     * 换主题走的是 setAppearance 那条路，字符串一次就变，跟得上。
     */
    private fun syncThemePalette() {
        val palette = WallpaperThemePalette.read(context)
        val nextPrimary = if (palette[0] == null || palette[0].isEmpty()) null else palette[0]
        val nextSecondary = if (palette[1] == null || palette[1].isEmpty()) null else palette[1]
        if (if (nextPrimary == null) palettePrimary != null else nextPrimary != palettePrimary) {
            palettePrimary = nextPrimary
            primaryTarget = rgbFromColor(if (nextPrimary == null)
                FALLBACK_PRIMARY
            else
                safeParseColor(nextPrimary, FALLBACK_PRIMARY))
        }
        if (if (nextSecondary == null) paletteSecondary != null else nextSecondary != paletteSecondary) {
            paletteSecondary = nextSecondary
            secondaryTarget = rgbFromColor(if (nextSecondary == null)
                FALLBACK_SECONDARY
            else
                safeParseColor(nextSecondary, FALLBACK_SECONDARY))
        }
    }

    /**
     * 主题换过就重新解析一次 `wordColors`。
     *
     * 不能挂在 `Snapshot.stamp` 上：换主题走的是 setAppearance 那条路，它不动 stamp
     * （stamp 只在换歌时变）—— 只认 stamp 的话，「暂停时换个 AI 主题」这边永远看不到。
     * 所以每帧自己比一次 JSON 串：SharedPreferences 读出来的是同一份缓存对象，
     * 绝大多数帧只是比个引用。
     */
    private fun syncWordRules() {
        val themeJson = WallpaperThemePalette.readThemeJson(context)
        if (if (themeJson == null) wordThemeJson == null else themeJson == wordThemeJson) {
            return
        }
        wordThemeJson = themeJson
        wordRules = FloatingWordColors.parse(themeJson)
    }

    /**
     * 这一行**每个字符位置**各该是什么颜色（没被标到的位置是 NO_COLOR）。
     *
     * `FloatingWordColors.segments` 给的是「每个词占行文本哪一段」，而 drawPerChar 是按
     * code point 逐个画的，所以要先摊平到字符位置上。
     * 结果按行缓存：同一句在换行后的动画期间会被画几十帧，每帧摊一遍纯属浪费。
     */
    private fun charColorsFor(line: WallpaperLyricsState.TimedLine?): IntArray? {
        if (wordRules.isEmpty() || line == null) {
            return null
        }
        if (charColors != null && charColorLine === line && charColorRules === wordRules) {
            return charColors
        }
        val text = line.text
        if (text == null || text.isEmpty()) {
            return null
        }
        val result = IntArray(text.length)
        java.util.Arrays.fill(result, FloatingWordColors.NO_COLOR)
        val segments = FloatingWordColors.segments(text, line.words, wordRules)
        for (i in segments.indices) {
            val segment = segments[i]
            if (segment == null || segment.color == FloatingWordColors.NO_COLOR) {
                continue
            }
            val start = Math.max(0, segment.startOffset)
            val end = Math.min(result.size, segment.endOffset)
            for (k in start until end) {
                result[k] = segment.color
            }
        }
        charColorLine = line
        charColorRules = wordRules
        charColors = result
        return result
    }

    /**
     * 第 codePointIndex 个字有没有被 AI 主题单独标色。
     *
     * @return null = 没有，走整行渐变；否则返回一个长度 3 的 rgb（容器复用）。
     */
    private fun endpointFor(text: String?, colors: IntArray?, codePointIndex: Int): FloatArray? {
        if (colors == null || text == null || text.isEmpty()) {
            return null
        }
        val offset: Int
        try {
            // charBounds 是按 code point 切的，而 colors 是按 Java char 下标摊的。
            offset = text.offsetByCodePoints(0, codePointIndex)
        } catch (error: IndexOutOfBoundsException) {
            return null
        }
        if (offset < 0 || offset >= colors.size) {
            return null
        }
        val color = colors[offset]
        if (color == FloatingWordColors.NO_COLOR) {
            return null
        }
        // 不掺上面那套缓动、直接取目标值：词的专色是「有或没有」的离散事实，
        // 走插值只会让换主题的那一瞬冒出一段谁都没选过的中间色。
        wordEndpoint[0] = ((color shr 16) and 0xFF) / 255f
        wordEndpoint[1] = ((color shr 8) and 0xFF) / 255f
        wordEndpoint[2] = (color and 0xFF) / 255f
        return wordEndpoint
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
    private fun drawProgressBar(snapshot: WallpaperLyricsState.Snapshot) {
        if (!snapshot.showProgress || snapshot.durationMs <= 0L || solidTexture == 0) {
            return
        }
        val ratio = clamp(snapshot.positionMs() / snapshot.durationMs.toFloat(), 0f, 1f)
        val width = surfaceWidth * 0.62f
        val left = (surfaceWidth - width) * 0.5f
        val height = Math.max(2f, surfaceHeight * 0.0045f)
        val top = surfaceHeight * 0.082f

        // 轨道：一层很淡的白，深色与浅色底图上都看得出边界。
        // alpha 乘 uiAlpha：暂停 / 心跳断的淡出走的就是它（见 onDrawFrame）。
        drawTexturedQuad(solidTexture, left, top, width, height, 1f, 1f, 1f, 0.15f * uiAlpha, -1f, 0f, 1f)
        if (ratio <= 0f) {
            return
        }
        // 已播放的那段沿长度方向在封面两色之间渐变。GLES2 里做渐变最省事的办法就是
        // 分段画：段与段之间多叠半像素，避免接缝处露出轨道的暗线。
        val filled = width * ratio
        val segments = 10
        val segment = filled / segments
        for (i in 0 until segments) {
            val t = if (segments > 1) i / (segments - 1).toFloat() else 1f
            val r = coverTint[0] + (coverTint2[0] - coverTint[0]) * t
            val g = coverTint[1] + (coverTint2[1] - coverTint[1]) * t
            val b = coverTint[2] + (coverTint2[2] - coverTint[2]) * t
            drawTexturedQuad(solidTexture, left + i * segment, top,
                    segment + 0.6f, height, r, g, b, 0.92f * uiAlpha, -1f, 0f, 1f)
        }
    }

    // ---- 背景 ----

    private fun drawBackground() {
        if (backgroundProgram == 0) {
            return
        }
        GLES20.glUseProgram(backgroundProgram)
        GLES20.glDisable(GLES20.GL_BLEND)

        val position = GLES20.glGetAttribLocation(backgroundProgram, "aPosition")
        val uv = GLES20.glGetAttribLocation(backgroundProgram, "aUv")
        bindQuad(position, uv)

        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uTime"), elapsedSeconds)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uAspect"),
                surfaceWidth / surfaceHeight.toFloat())
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uOffsetX"), offsetX)
        GLES20.glUniform3f(GLES20.glGetUniformLocation(backgroundProgram, "uAccent"),
                accent[0], accent[1], accent[2])
        GLES20.glUniform3f(GLES20.glGetUniformLocation(backgroundProgram, "uBase"),
                base[0], base[1], base[2])
        // ---- 实验台配置（当前模式那一份）----
        // cameraIntensity：播放页里控制相机推拉强度，壁纸上等价的是背景整体的流动幅度。
        val cameraIntensity = Math.max(0f, tf("cameraIntensity", 1f))
        // mgDensity：背景「mg」层（光团）的密度。
        val mgDensity = tf("mgDensity", 1f)
        val showOnlyText = tb("showOnlyText", false)
        val showBackgroundMg = tb("showBackgroundMg", true)
        val showBackgroundDecor = tb("showBackgroundDecor", true)
        val postProcessEnabled = tb("postProcessEnabled", false)
        // 应用侧「视觉设置」里的背景开关，壁纸上改成它的原生对应物。
        // 字段名带 wp. 前缀：它们不属于某个模式的 tuning，而是全局设置，
        // 跟 per-mode 字段混在同一张表里靠前缀区分。
        val backgroundOpacity = clamp(tf("wp.backgroundOpacity", 1f), 0f, 1f)
        val vignetteDisabled = tb("wp.vignetteDisabled", false)
        val geometricDisabled = tb("wp.geometricDisabled", false)

        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uMotion"),
                motion * style.flowSpeed * cameraIntensity)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uBlob"),
                if (showOnlyText || !showBackgroundMg) 0f else style.blobScale * mgDensity)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uDust"),
                if (showOnlyText || !showBackgroundDecor) 0f else style.dust)
        // 背景不透明度：应用里那个滑杆直接压在壁纸背景层的强度上。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uGlow"),
                (if (showOnlyText) 0f else style.glow) * backgroundOpacity)
        // 后处理默认走 base 行为（暗角系数 0.85、无颗粒、无对比度增强），
        // 只有实验台把总开关打开时才追加实验台里的数值。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpGrain"),
                if (postProcessEnabled) clamp(tf("postProcessGrain", 0f), 0f, 1f) else 0f)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpContrast"),
                if (postProcessEnabled) clamp(tf("postProcessContrast", 0f), -0.9f, 1f) else 0f)
        // 关掉暗角 = 不压边缘（0 = 完全不压暗，见着色器里 mix(0.52, 1.0, vig) 的等价写法）。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uPpVignette"),
                if (vignetteDisabled) -1f
                else if (postProcessEnabled) clamp(tf("postProcessVignette", 0.85f), 0f, 2f)
                else 0.85f)
        GLES20.glUniform4f(GLES20.glGetUniformLocation(backgroundProgram, "uRect"),
                -1f, -1f, 2f, 2f)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        unbindQuad(position, uv)
        GLES20.glEnable(GLES20.GL_BLEND)
    }

    /**
     * 按 cover 方式铺满：长边对齐、短边裁掉，保持图片自身比例。
     * 直接拉成屏幕尺寸的话，竖图会被压扁、横图会被拉长 —— 这是「拉伸」的来源。
     */
    private fun drawCoverFitted(texture: Int, bitmapWidth: Int, bitmapHeight: Int, alpha: Float) {
        if (texture == 0 || quadProgram == 0 || bitmapWidth <= 0 || bitmapHeight <= 0) {
            return
        }
        val scale = Math.max(surfaceWidth / bitmapWidth.toFloat(),
                surfaceHeight / bitmapHeight.toFloat())
        val width = bitmapWidth * scale
        val height = bitmapHeight * scale
        val left = (surfaceWidth - width) * 0.5f
        val top = (surfaceHeight - height) * 0.5f
        drawTexturedQuad(texture, left, top, width, height,
                1f, 1f, 1f, alpha, -1f, 1f, 1f)
    }

    private fun drawCover() {
        // 封面那层的浓淡跟着应用侧的背景不透明度走，两边观感才一致。
        val opacity = clamp(tf("wp.backgroundOpacity", 1f), 0f, 1f)
        val alpha = 0.28f * opacity
        /*
         * 交叉淡出。
         *
         * 旧图按 (1 - t) 淡出、新图按 t 淡入，两层同时画。合起来的浓度仍然是 alpha
         * （中间只差 alpha²/4，0.28 时不到 2%），所以底色不会在过渡中间发暗或发亮 ——
         * 如果改成「新图直接从 0 涨到 alpha」，中途会看到整体变淡一下。
         *
         * 用墙钟算 t 而不是每帧累加：这一层在非 cover 模式下不画（切到自选图 / 视频），
         * 累加的话切回来还停在中途；按时间算，切回来时早就淡完了。
         */
        var fade = 1f
        if (coverFadeStartNanos != 0L) {
            fade = clamp((System.nanoTime() - coverFadeStartNanos) / (COVER_FADE_SECONDS * 1e9f), 0f, 1f)
        }
        if (coverPrevTexture != 0 && fade < 1f) {
            drawCoverFitted(coverPrevTexture, coverPrevWidth, coverPrevHeight, alpha * (1f - fade))
        }
        if (fade > 0f) {
            drawCoverFitted(coverTexture, coverWidth, coverHeight, alpha * fade)
        }
        if (fade >= 1f && coverPrevTexture != 0) {
            // 淡完了才真正释放旧纹理：早一帧删，那一帧就是空白。
            releaseCoverPrev()
        }
    }

    /** 自选背景图铺满，再压一层薄薄的暗色蒙版保证歌词可读。 */
    private fun drawImage() {
        if (imageTexture == 0 || quadProgram == 0) {
            return
        }
        drawCoverFitted(imageTexture, imageWidth, imageHeight, 1f)
        // 蒙版铺满整屏：uUseTexColor=0 时着色器只用 uColor，纹理内容不参与。
        drawTexturedQuad(imageTexture, 0f, 0f, surfaceWidth.toFloat(), surfaceHeight.toFloat(),
                0f, 0f, 0f, 0.22f, -1f, 0f, 1f)
    }

    /**
     * 自选图从私有文件里读，不从内存里的 base64 解 —— 这样壁纸服务不管什么时候被系统拉起、
     * 应用进程被回收过几次，只要那张图还在磁盘上就能画出来。
     */
    private fun syncImage(imageKey: String?) {
        if (imageKey == null) {
            // 没选图（或用户刚清除）时必须把纹理放掉：只 return 的话上一张图会一直挂在画面上。
            if (loadedImageKey != null) {
                loadedImageKey = null
                releaseImage()
            }
            return
        }
        if (imageKey == loadedImageKey) {
            return
        }
        loadedImageKey = imageKey
        val decoded = WallpaperBackgroundImage.load(context)
        if (decoded == null) {
            return
        }
        if (imageTexture != 0) {
            GLES20.glDeleteTextures(1, intArrayOf(imageTexture), 0)
            imageTexture = 0
        }
        // 自选图同样吃模糊滑杆：有人就是想要那张图「糊一点」当底色。
        // 2560 的图缩到 12px 再放大回去代价不小，所以先压到 1600 再处理。
        var source = decoded
        val edge = Math.max(decoded.width, decoded.height)
        if (blurAmount > 0.02f && edge > 1600) {
            val ratio = 1600f / edge
            source = Bitmap.createScaledBitmap(decoded,
                    Math.max(1, Math.round(decoded.width * ratio)),
                    Math.max(1, Math.round(decoded.height * ratio)), true)
            decoded.recycle()
        }
        val blurred = blurredCover(source, blurAmount)
        if (blurred !== source) {
            source.recycle()
        }
        imageTexture = upload(blurred)
        imageWidth = blurred.width
        imageHeight = blurred.height
        blurred.recycle()
    }

    // ---- 视频背景 ----

    /**
     * 让「视频背景」跟着模式走：选中就起播放器，切走就整个放掉。
     *
     * 只在 GL 线程里进出（onDrawFrame / onSurfaceCreated）—— SurfaceTexture 必须挂在
     * 当前这个 GL 上下文上，换个线程建出来的纹理画不出来。
     */
    private fun syncVideo(wanted: Boolean) {
        if (!wanted) {
            if (loadedVideoKey != null) {
                loadedVideoKey = null
                releaseVideoResources()
            }
            return
        }
        val key = WallpaperBackgroundVideo.key(context)
        if (key == null) {
            // 选了视频但文件不在（用户清掉了 / 还没上传）：退回普通背景，别留黑屏。
            if (loadedVideoKey != null) {
                loadedVideoKey = null
                releaseVideoResources()
            }
            return
        }
        if (key == loadedVideoKey && videoPlayer != null) {
            // 已经在播了：只要把最新的一帧取到纹理上。
            updateVideoFrame()
            return
        }
        releaseVideoResources()
        loadedVideoKey = key
        val path = WallpaperBackgroundVideo.path(context)
        if (path == null) {
            return
        }
        try {
            val ids = IntArray(1)
            GLES20.glGenTextures(1, ids, 0)
            videoTexture = ids[0]
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, videoTexture)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            val surfaceTexture = SurfaceTexture(videoTexture)
            videoSurfaceTexture = surfaceTexture
            videoSurface = Surface(surfaceTexture)
            val player = MediaPlayer()
            player.setDataSource(path)
            player.setSurface(videoSurface)
            // 静音 + 循环：它是背景，声音归音乐，也不该播完就停住。
            player.setVolume(0f, 0f)
            player.setLooping(true)
            player.setOnVideoSizeChangedListener { _, width, height ->
                videoWidth = width
                videoHeight = height
            }
            player.setOnPreparedListener { mp ->
                videoWidth = mp.getVideoWidth()
                videoHeight = mp.getVideoHeight()
                if (_videoActive) {
                    try {
                        mp.start()
                    } catch (ignored: Throwable) {
                        // 起不来就当没选过视频，下一帧会退回普通背景。
                    }
                }
            }
            player.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "Wallpaper video playback failed: " + what + "/" + extra)
                true
            }
            // 异步 prepare：同步那版会在这个线程上直接卡住解码器的初始化。
            player.prepareAsync()
            videoPlayer = player
        } catch (error: Throwable) {
            Log.w(TAG, "Could not start the wallpaper video", error)
            releaseVideoResources()
        }
    }

    /** 把 SurfaceTexture 上最新的一帧搬进 OES 纹理，并取回这一帧的采样变换。 */
    private fun updateVideoFrame() {
        val surfaceTexture = videoSurfaceTexture ?: return
        try {
            surfaceTexture.updateTexImage()
            surfaceTexture.getTransformMatrix(videoTransform)
        } catch (ignored: Throwable) {
            // 纹理已被释放：下一轮 syncVideo 会重建。
        }
    }

    private fun drawVideo() {
        if (videoProgram == 0 || videoTexture == 0) {
            return
        }
        updateVideoFrame()
        GLES20.glUseProgram(videoProgram)
        GLES20.glDisable(GLES20.GL_BLEND)

        val position = GLES20.glGetAttribLocation(videoProgram, "aPosition")
        val uv = GLES20.glGetAttribLocation(videoProgram, "aUv")
        bindQuad(position, uv)

        /*
         * 和封面同一套 cover 逻辑：保持视频自身比例铺满，多出来的裁掉。
         * 直接拉满屏幕的话，横屏视频会被压成一张胖脸。
         * 裁剪做在采样区间上（uUvRect），不动顶点 —— OES 纹理同样吃这套 UV。
         */
        var uvX = 0f
        var uvY = 0f
        var uvW = 1f
        var uvH = 1f
        if (videoWidth > 0 && videoHeight > 0) {
            val screenAspect = surfaceWidth / surfaceHeight.toFloat()
            val videoAspect = videoWidth / videoHeight.toFloat()
            if (videoAspect > screenAspect) {
                uvW = screenAspect / videoAspect
                uvX = (1f - uvW) * 0.5f
            } else {
                uvH = videoAspect / screenAspect
                uvY = (1f - uvH) * 0.5f
            }
        }
        GLES20.glUniform4f(GLES20.glGetUniformLocation(videoProgram, "uRect"),
                -1f, -1f, 2f, 2f)
        GLES20.glUniform4f(GLES20.glGetUniformLocation(videoProgram, "uUvRect"),
                uvX, uvY, uvW, uvH)
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(videoProgram, "uTexMatrix"),
                1, false, videoTransform, 0)
        // 压一层薄薄的暗色：视频画面亮度没准，不压的话歌词经常看不清。
        GLES20.glUniform1f(GLES20.glGetUniformLocation(videoProgram, "uDim"), 0.22f)

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, videoTexture)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(videoProgram, "uTexture"), 0)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        unbindQuad(position, uv)
        GLES20.glEnable(GLES20.GL_BLEND)
    }

    private fun releaseVideoResources() {
        val player = videoPlayer
        if (player != null) {
            try {
                player.release()
            } catch (ignored: Throwable) {
                // 播放器已经坏了就不用管了。
            }
            videoPlayer = null
        }
        val surface = videoSurface
        if (surface != null) {
            surface.release()
            videoSurface = null
        }
        val surfaceTexture = videoSurfaceTexture
        if (surfaceTexture != null) {
            surfaceTexture.release()
            videoSurfaceTexture = null
        }
        if (videoTexture != 0) {
            GLES20.glDeleteTextures(1, intArrayOf(videoTexture), 0)
            videoTexture = 0
        }
        videoWidth = 0
        videoHeight = 0
    }

    /**
     * 壁纸可见性变化时由 Engine 调用：不可见就暂停解码，回来再续上。
     *
     * 停渲染循环（glView.onPause）并不会停掉 MediaPlayer —— 它照样在后台一帧一帧解，
     * 息屏后那几个小时就是纯耗电。
     */
    fun setVideoActive(active: Boolean) {
        _videoActive = active
        val player = videoPlayer ?: return
        try {
            if (active) {
                player.start()
            } else {
                player.pause()
            }
        } catch (ignored: Throwable) {
            // 还没 prepare 完 / 已经 release 了。
        }
    }

    /** 引擎销毁时调用：解码器必须显式放掉，不然它会一直挂在进程里。 */
    fun releaseVideo() {
        loadedVideoKey = null
        releaseVideoResources()
    }

    // ---- 歌词 ----

    private fun drawLyrics(snapshot: WallpaperLyricsState.Snapshot) {
        if (quadProgram == 0) {
            return
        }
        if (snapshot.isEmpty()) {
            return
        }

        // 双行：整条时间轴里得真有翻译才开。全是单语歌时不会因为开关而多留出空位。
        val dualLine = snapshot.showTranslation && snapshot.hasTranslation

        val baseFontPx = clamp(surfaceHeight * 0.062f, 26f, 84f)
        val subFontPx = Math.round(baseFontPx * TRANSLATION_FONT_RATIO).toFloat()
        var lineStep = surfaceHeight * style.lineSpacing
        if (dualLine) {
            // 行距必须装得下「主行 + 翻译行」，否则相邻两句会叠在一起。
            lineStep = Math.max(lineStep, (baseFontPx + subFontPx) * TEXTURE_HEIGHT_FACTOR)
        }
        // 双行时整块视觉重心下移了半行翻译，焦点位置跟着上抬一点。
        val centerY = surfaceHeight * (if (dualLine) 0.44f else 0.47f)
        val maxWidth = surfaceWidth * 0.84f
        // 垫在歌词后面的背景字（不带任何线条 —— 线条装饰已经整块移除）。
        drawBackdropText(snapshot, centerY, lineStep)

        val first = Math.max(0, Math.floor(animatedIndex.toDouble()).toInt() - VISIBLE_SPAN)
        val last = Math.min(snapshot.lines.size - 1,
                Math.ceil(animatedIndex.toDouble()).toInt() + VISIBLE_SPAN)

        for (i in first..last) {
            val text = snapshot.lines[i].text
            if (text == null || text.trim().isEmpty()) {
                continue
            }
            val signed = i - animatedIndex
            val distance = Math.abs(signed)
            // 槽位是离散的：最外侧那一行把 [VISIBLE_SPAN-1, VISIBLE_SPAN] 这一整行的
            // 距离当作自己的动画全程，走完就被裁掉（此刻 alpha 已经是 0，看不出裁剪）。
            if (distance > VISIBLE_SPAN + 0.02f) {
                continue
            }
            /*
             * 边缘行的进出场动画 —— 这是**列表**的进出，不是卷轴的滚动：
             *   最上面那行（唱过去的）：向上**加速飞出屏幕外**（EXIT_FLY，按 edgeT² 加速）
             *     并淡到 0、缩一点，像被丢出去；
             *   最下面那行（还没唱到的）：从下方 ENTER_RISE 个行距处**滑进来**并淡入。
             * 过渡带占**整整一行**的距离（以前只给半行，动画还没展开就没了，等于没有）。
             * 拖进度条倒着走时这两段是对称的，不会出现凭空冒出来的行。
             */
            val edgeT = clamp(distance - (VISIBLE_SPAN - 1f), 0f, 1f)
            var edgeShift = 0f
            var edgeAlpha = 1f
            var edgeScale = 1f
            if (edgeT > 0f) {
                // 位移轻微加速（起步慢一点、越飞越快），但**不是**纯 t² ——
                // 纯 t² 的话前半程几乎不动，等它动起来 alpha 已经淡没了。
                val travel = edgeT * (0.35f + 0.65f * edgeT)
                // 出场那侧走 EXIT_FLY（半屏，真的飞出屏幕外）；
                // 入场那侧走 ENTER_RISE（从屏幕下沿外一点滑进来，不需要那么远）。
                edgeShift = if (signed < 0f)
                    -lineStep * EXIT_FLY * travel
                else
                    lineStep * ENTER_RISE * travel
                edgeScale = 1f - EXIT_SHRINK * edgeT
                // 淡出集中在后半程（1 - t²）：先让它飞，飞出去了再淡掉。
                // 用 1 - t 的话它还没飞出去就已经看不见了 —— 等于没有动画。
                edgeAlpha = 1f - edgeT * edgeT
            }

            val texture = textureFor(text, Math.round(baseFontPx))
            if (texture == null) {
                continue
            }

            var scale = 1f - Math.min(0.34f, 0.13f * distance)
            // typographyMotion：播放页里控制排版自身的呼吸/浮动。
            // 注意它的默认值是 1（= 播放页的正常强度），不是 0 —— 所以这里的幅度必须做得很小，
            // 否则每个没动过这条设置的人都会看到歌词在上下漂。
            val typographyMotion = Math.max(0f, tf("typographyMotion", 0f))
            var bob = 0f
            if (distance < 0.5f) {
                scale *= style.currentScale
                if (typographyMotion > 0.001f) {
                    scale *= 1f + 0.010f * Math.sin((elapsedSeconds * 1.7f).toDouble()).toFloat() * typographyMotion
                    // `*` 必须留在上一行行尾（Kotlin 2.3 把握手行首的 `*` 读成新语句）。
                    bob = Math.sin((elapsedSeconds * 1.15f).toDouble()).toFloat() *
                            lineStep * 0.012f * typographyMotion
                }
            }
            var width = texture.width * scale * edgeScale
            var height = texture.height * scale * edgeScale
            if (width > maxWidth) {
                val fit = maxWidth / width
                width *= fit
                height *= fit
            }
            // 亮度衰减最多算到 FALLOFF_MAX_DISTANCE 行：再往外还继续压暗的话，
            // 最外侧那行轮到它做飞出/出现动画时已经暗得看不见了 —— 等于没有动画。
            // alpha 乘 uiAlpha：暂停 / 心跳断时整块歌词一起淡出（见 onDrawFrame）。
            var alpha = clamp(1f - style.falloff * Math.min(distance, FALLOFF_MAX_DISTANCE),
                    0f, 1f) * edgeAlpha * uiAlpha
            val isCurrent = distance < 0.5f
            /*
             * **每一行有自己的进度**，不是全场共用一个值：
             *   唱过的行 = 1（字全部浮起，并保持这个状态），
             *   正在唱的行 = 行内进度（逐字浮起），
             *   还没唱到的行 = 0（停在原位，等着浮）。
             * 共用一个值的话，换行时旧行会被新行的 0 拉回去 —— 就是「突然下浮」。
             */
            val isSinging = i == lastComputedIndex
            val rowProgress = if (i < lastComputedIndex) 1f
            else (if (isSinging) clamp(animatedProgress, 0f, 1f) else 0f)
            // 换行走入：新的一句从下方 LINE_ENTER_RISE 个行距处滑上来并淡入。
            // 缓出曲线 —— 快进慢收，落位那一下才不会「顿」。
            val enter = if (isCurrent) easeOutCubic(clamp(lineEnter, 0f, 1f)) else 1f
            alpha *= clamp(1f - LINE_ENTER_RISE * 2.6f * (1f - enter), 0f, 1f)
            // 整行渐变：起手就抬到一半亮度，剩下的由行内进度推满。
            // 不做「从 0 开始」——那会让整行在行首那一瞬几乎看不见。
            if (style.textEffect == 1 && isSinging) {
                alpha *= clamp(0.62f + 0.38f * rowProgress, 0f, 1f)
            }
            if (isCurrent) {
                // 极缓的呼吸：亮度 ±5%、大小 ±0.6%。周期故意开得很长（约 4 秒一轮），
                // 扫一眼看不出在动，但盯久了字不像贴上去的。
                // 注意：width/height 在这之前已经按 scale 算完了，所以这里直接改尺寸。
                val breath = Math.sin((elapsedSeconds * 1.55f).toDouble()).toFloat()
                alpha *= 1f - LINE_BREATH * 0.5f + LINE_BREATH * 0.5f * breath
                val breathScale = 1f + 0.006f * breath
                width *= breathScale
                height *= breathScale
            }
            // 跟唱上浮：整行一起抬多少（逐字上浮时 progressLift = 0，动的是每个字）。
            val lift = if (isCurrent)
                -lineStep * style.progressLift * rowProgress +
                        lineStep * LINE_ENTER_RISE * (1f - enter)
            else 0f
            /*
             * **浮起状态要跨行连续**：唱过的行整行保持浮起（= 行末逐字浮完的那个位移），
             * 还没唱到的行停在原位等着浮。唱完 → 让位 → 新行接手，全程没有位移往回走。
             * 判定用行号而不是 signed：换行那几百毫秒里 animatedIndex 还在上一行附近，
             * 用 signed 会把「正在唱的新行」错判成已唱完的行。
             */
            val charLift = if (isSinging) 0f else (if (i < lastComputedIndex) -lineStep * CHAR_RISE else 0f)
            val y = centerY + signed * lineStep + bob + lift + charLift + edgeShift
            // textEffect=0 传行内进度（横向擦到第几个字）；=1 传整行亮度；
            // =2 不做高亮，传 -1 走纯色分支；=3 逐字上浮由 drawPerChar 自己算每个字的进度。
            val progress = if (isSinging && style.textEffect <= 1) rowProgress else -1f

            if (isSinging && style.textEffect == 3) {
                drawPerChar(texture, y, width, height, alpha, rowProgress, lineStep,
                        text, charColorsFor(snapshot.lines[i]))
            } else {
                drawCentered(texture, y, width, height, alpha, progress, style.textEffect == 1)
            }

            if (!dualLine) {
                continue
            }
            val translation = snapshot.lines[i].translation
            if (translation == null || translation.trim().isEmpty()) {
                // 这一行没翻译：不画、也不留空位。
                continue
            }
            val subTexture = textureFor(translation, Math.round(subFontPx))
            if (subTexture == null) {
                continue
            }
            var subWidth = subTexture.width * scale
            var subHeight = subTexture.height * scale
            if (subWidth > maxWidth) {
                val fit = maxWidth / subWidth
                subWidth *= fit
                subHeight *= fit
            }
            // 贴着主行底边往下排 —— 两行各自的留白合起来就是行间距。
            // 翻译不做高亮：主行已经在亮了，两行一起推会显得很吵。
            drawTinted(subTexture, y + height * 0.5f + subHeight * 0.5f,
                    subWidth, subHeight, alpha * 0.86f,
                    secondary[0], secondary[1], secondary[2])
        }
    }

    /**
     * 垫在歌词后面的巨型装饰字：把当前这行放大到很淡的一层当背景纹理。
     *
     * **曾经这里还有一整套线条装饰**（外框 + 四角标、焦点行上下的引导线、三圈呼吸细框），
     * 用户明确要求「原生壁纸有线条背景去掉」，已经整块删除，连画线的 stroke() 一起。
     * 别再往这里加框线 —— 需要线条的话应该去叠层那一层做。
     */
    private fun drawBackdropText(snapshot: WallpaperLyricsState.Snapshot, centerY: Float, lineStep: Float) {
        if (quadProgram == 0 || snapshot.isEmpty()) {
            return
        }
        if ("sonnet" != activeMode) {
            return
        }
        val index = snapshot.indexAt(snapshot.positionMs())
        if (index >= snapshot.lines.size) {
            return
        }
        val current = snapshot.lines[index].text
        if (current == null) {
            return
        }
        val width = surfaceWidth * 0.84f

        if (tb("showGiantDecorativeText", true) && current.trim().length > 0) {
            val giantFont = Math.round(clamp(surfaceHeight * 0.062f, 26f, 84f) * 2.2f)
            val giant = textureFor(current, giantFont)
            if (giant != null) {
                val ratio = Math.min(1f, width / giant.width)
                drawCentered(giant, centerY - lineStep * 0.15f,
                        giant.width * ratio, giant.height * ratio, 0.055f * uiAlpha, -1f)
            }
        }
    }

    private fun drawCentered(texture: TextTexture, centerYPx: Float, widthPx: Float, heightPx: Float,
                             alpha: Float, progress: Float) {
        drawCentered(texture, centerYPx, widthPx, heightPx, alpha, progress, false)
    }

    /**
     * @param wholeLine true = 整行渐变：进度只推整行亮度，不做横向擦除（不会逐字亮起来）。
     */
    private fun drawCentered(texture: TextTexture, centerYPx: Float, widthPx: Float, heightPx: Float,
                             alpha: Float, progress: Float, wholeLine: Boolean) {
        val left = (surfaceWidth - widthPx) * 0.5f
        val top = centerYPx - heightPx * 0.5f
        // 没点亮的底色用暗白；整行模式下整行铺主题渐变，进度把亮度推上去。
        // 边缘光的强度跟着光晕走：这就是「歌词有多亮」的观感来源之一。
        drawTexturedQuad(texture.textureId, left, top, widthPx, heightPx,
                primary[0], primary[1], primary[2], alpha, progress, 0f, highlightBoost(), wholeLine)
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
    private fun drawPerChar(texture: TextTexture, centerYPx: Float, widthPx: Float, heightPx: Float,
                            alpha: Float, lineProgress: Float, lineStep: Float,
                            lineText: String, colors: IntArray?) {
        val bounds = texture.charBounds
        val count = if (bounds != null) bounds.size - 1 else 0
        if (count <= 0 || widthPx <= 0f) {
            drawCentered(texture, centerYPx, widthPx, heightPx, alpha,
                    clamp(lineProgress, 0f, 1f), true)
            return
        }
        val left = (surfaceWidth - widthPx) * 0.5f
        val top = centerYPx - heightPx * 0.5f
        val texW = Math.max(1f, texture.width.toFloat())
        val step = if (count > 1) (1f - CHAR_SPAN) / (count - 1) else 0f
        for (c in 0 until count) {
            val t = clamp((lineProgress - c * step) / CHAR_SPAN, 0f, 1f)
            val u0 = bounds[c] / texW
            val u1 = bounds[c + 1] / texW
            val charWidth = Math.max(1f, (u1 - u0) * widthPx)
            val rise = -lineStep * CHAR_RISE * easeOutCubic(t)
            /*
             * AI 主题给这个词单独指定的颜色：有就整条渐变的两端都换成它
             * （两端同值 = 这个字是纯色，不再掺行渐变），没有就走整行那条。
             * 和悬浮小窗同一个语义 —— 命中词的**唱过去的那一段**用它，没唱到的仍偏主文本色。
             */
            drawTexturedQuad(texture.textureId, left + u0 * widthPx, top + rise,
                    charWidth, heightPx, primary[0], primary[1], primary[2], alpha,
                    t, 0f, highlightBoost(), true, u0, 0f, u1 - u0, 1f,
                    endpointFor(lineText, colors, c))
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
    private fun tf(key: String, fallback: Float): Float {
        val value = tuning[key]
        return value ?: fallback
    }

    /** 布尔开关：0 = 关。缺省视为「开」（默认值多为 true）。 */
    private fun tb(key: String, fallback: Boolean): Boolean {
        val value = tuning[key] ?: return fallback
        return value >= 0.5f
    }

    private fun highlightBoost(): Float {
        return Math.min(1.6f, Math.max(0.5f, style.glow))
    }

    private fun drawTinted(texture: TextTexture, centerYPx: Float, widthPx: Float, heightPx: Float,
                           alpha: Float, r: Float, g: Float, b: Float) {
        val left = (surfaceWidth - widthPx) * 0.5f
        val top = centerYPx - heightPx * 0.5f
        drawTexturedQuad(texture.textureId, left, top, widthPx, heightPx, r, g, b, alpha, -1f, 0f, 1f)
    }

    private fun drawTexturedQuad(textureId: Int, leftPx: Float, topPx: Float, widthPx: Float,
                                 heightPx: Float, r: Float, g: Float, b: Float, alpha: Float,
                                 progress: Float, useTextureColor: Float, glowBoost: Float) {
        drawTexturedQuad(textureId, leftPx, topPx, widthPx, heightPx, r, g, b, alpha,
                progress, useTextureColor, glowBoost, false)
    }

    /**
     * @param wholeLine 整行模式：进度推的是整行亮度，不是横向擦除到第几个字。
     */
    private fun drawTexturedQuad(textureId: Int, leftPx: Float, topPx: Float, widthPx: Float,
                                 heightPx: Float, r: Float, g: Float, b: Float, alpha: Float,
                                 progress: Float, useTextureColor: Float, glowBoost: Float,
                                 wholeLine: Boolean) {
        drawTexturedQuad(textureId, leftPx, topPx, widthPx, heightPx, r, g, b, alpha,
                progress, useTextureColor, glowBoost, wholeLine, 0f, 0f, 1f, 1f)
    }

    /**
     * @param wholeLine 整行模式：进度推的是整行亮度，不是横向擦除到第几个字。
     * @param uvX/uvY/uvW/uvH 只采样纹理里的这一小块（逐字上浮按字切 UV）。
     */
    private fun drawTexturedQuad(textureId: Int, leftPx: Float, topPx: Float, widthPx: Float,
                                 heightPx: Float, r: Float, g: Float, b: Float, alpha: Float,
                                 progress: Float, useTextureColor: Float, glowBoost: Float,
                                 wholeLine: Boolean, uvX: Float, uvY: Float, uvW: Float, uvH: Float) {
        drawTexturedQuad(textureId, leftPx, topPx, widthPx, heightPx, r, g, b, alpha,
                progress, useTextureColor, glowBoost, wholeLine, uvX, uvY, uvW, uvH, null)
    }

    /**
     * @param endpoints 非 null 时整行渐变的**两个端点都换成它**（AI 主题给某个词的专色）。
     *                  两端给同一个值 = 这一次画的东西是纯色，不再掺行渐变。
     */
    private fun drawTexturedQuad(textureId: Int, leftPx: Float, topPx: Float, widthPx: Float,
                                 heightPx: Float, r: Float, g: Float, b: Float, alpha: Float,
                                 progress: Float, useTextureColor: Float, glowBoost: Float,
                                 wholeLine: Boolean, uvX: Float, uvY: Float, uvW: Float, uvH: Float,
                                 endpoints: FloatArray?) {
        if (quadProgram == 0) {
            return
        }
        GLES20.glUseProgram(quadProgram)

        val position = GLES20.glGetAttribLocation(quadProgram, "aPosition")
        val uv = GLES20.glGetAttribLocation(quadProgram, "aUv")
        bindQuad(position, uv)

        // 像素坐标 → NDC。uRect 记的是矩形**下边**那条线（aPosition.y=0 落在那里），
        // 高度是往上长的，所以 y 必须先减掉 h：少减这一步的话整个矩形会上移自身高度，
        // 歌词只是偏了一行看不太出来，但铺满全屏的背景图会整个跑到屏幕外面去 ——
        // 表现就是「选了图却什么都没有」。
        val x = (leftPx / surfaceWidth) * 2f - 1f
        val w = (widthPx / surfaceWidth) * 2f
        val h = (heightPx / surfaceHeight) * 2f
        val y = 1f - (topPx / surfaceHeight) * 2f - h
        GLES20.glUniform4f(GLES20.glGetUniformLocation(quadProgram, "uRect"), x, y, w, h)
        GLES20.glUniform4f(GLES20.glGetUniformLocation(quadProgram, "uUvRect"),
                uvX, uvY, uvW, uvH)
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uColor"), r, g, b)
        // 整行渐变的两个端点用**歌词专用**那一对，不再用封面的 coverTint：
        // 后者是从 accent 的 HSV 派生出来的「主题假色」，跟 AI 主题真正的配色不是一回事，
        // 而且着色器里 uColor 只掺 20%，端点色才是决定观感的那个。
        val activeTint = endpoints ?: lyricTint
        val activeTint2 = endpoints ?: lyricTint2
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uActive"),
                activeTint[0], activeTint[1], activeTint[2])
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uActive2"),
                activeTint2[0], activeTint2[1], activeTint2[2])
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uGlow"),
                accent[0] * glowBoost, accent[1] * glowBoost, accent[2] * glowBoost)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uAlpha"), alpha)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uProgress"), progress)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uWholeLine"),
                if (wholeLine) 1f else 0f)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uUseTexColor"),
                useTextureColor)

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(quadProgram, "uTexture"), 0)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        unbindQuad(position, uv)
    }

    // ---- 纹理 ----

    private fun textureFor(text: String, fontPx: Int): TextTexture? {
        val key = text + '@' + fontPx
        val cached = textures[key]
        if (cached != null) {
            return cached
        }

        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = Color.WHITE
        paint.typeface = if (activeTypeface == null)
            Typeface.create("sans-serif", Typeface.BOLD)
        else
            activeTypeface
        paint.textSize = fontPx.toFloat()
        paint.textAlign = Paint.Align.LEFT

        val pad = Math.max(8, Math.round(fontPx * 0.25f))
        val textWidth = paint.measureText(text)
        val metrics: Paint.FontMetrics = paint.fontMetrics
        val textHeight = metrics.descent - metrics.ascent
        val bitmapWidth = Math.max(1, Math.ceil((textWidth + pad * 2f).toDouble()).toInt())
        val bitmapHeight = Math.max(1, Math.ceil((textHeight + pad * 2f).toDouble()).toInt())

        val bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawText(text, pad.toFloat(), pad - metrics.ascent, paint)

        val textureId = upload(bitmap)
        bitmap.recycle()
        if (textureId == 0) {
            return null
        }
        val texture = TextTexture(textureId, bitmapWidth, bitmapHeight,
                measureCharBounds(text, paint, pad))
        textures[key] = texture
        return texture
    }

    /**
     * 歌词字体。用户没选就用系统 sans-serif；选了但文件读不出来（选错文件、文件损坏）
     * 也静默回落，不能让一个坏字体把整个壁纸带走。
     */
    private fun syncFont(fontKey: String?) {
        if (fontKey == null) {
            if (loadedFontKey != null) {
                loadedFontKey = null
                activeTypeface = null
                // 字体变了，已经栅格化的行全部作废。
                clearTextures()
            }
            return
        }
        if (fontKey == loadedFontKey) {
            return
        }
        loadedFontKey = fontKey
        val loaded = WallpaperLyricsFont.load(context)
        if (loaded == null) {
            Log.w(TAG, "The chosen lyrics font could not be loaded; falling back to sans-serif")
            activeTypeface = null
        } else {
            activeTypeface = loaded
        }
        clearTextures()
    }

    private fun clearTextures() {
        for (texture in textures.values) {
            GLES20.glDeleteTextures(1, intArrayOf(texture.textureId), 0)
        }
        textures.clear()
    }

    private fun syncCover(coverBase64: String?) {
        if (coverBase64 == null || coverBase64 == loadedCoverKey) {
            return
        }
        val decoded = decodeCover(coverBase64)
        loadedCoverKey = coverBase64
        if (decoded == null) {
            return
        }
        val blurred = blurredCover(decoded, blurAmount)
        // 先上传新的、再挪旧的：上传万一失败，旧图还在画面上，不会黑一下。
        val next = upload(blurred)
        if (next != 0) {
            releaseCoverPrev()
            coverPrevTexture = coverTexture
            coverPrevWidth = coverWidth
            coverPrevHeight = coverHeight
            coverTexture = next
            coverWidth = blurred.width
            coverHeight = blurred.height
            /*
             * 从这一帧开始淡。上一张为 0（冷启动第一张、或换到别的背景模式后又切回来）
             * 就是「从无到有」—— 同一个公式照样成立，只是没有旧图那半层。
             */
            coverFadeStartNanos = System.nanoTime()
        }
        blurred.recycle()
        decoded.recycle()
    }

    // ---- GL 样板 ----

    private fun createUnitQuad(): Int {
        val vertices = floatArrayOf(
                0f, 0f, 0f, 0f,
                1f, 0f, 1f, 0f,
                0f, 1f, 0f, 1f,
                1f, 1f, 1f, 1f)
        val buffer = ByteBuffer.allocateDirect(vertices.size * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
        buffer.put(vertices).position(0)

        val ids = IntArray(1)
        GLES20.glGenBuffers(1, ids, 0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, ids[0])
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, vertices.size * 4, buffer, GLES20.GL_STATIC_DRAW)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        return ids[0]
    }

    private fun bindQuad(positionHandle: Int, uvHandle: Int) {
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quadBuffer)
        GLES20.glEnableVertexAttribArray(positionHandle)
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 16, 0)
        if (uvHandle >= 0) {
            GLES20.glEnableVertexAttribArray(uvHandle)
            GLES20.glVertexAttribPointer(uvHandle, 2, GLES20.GL_FLOAT, false, 16, 8)
        }
    }

    private fun unbindQuad(positionHandle: Int, uvHandle: Int) {
        GLES20.glDisableVertexAttribArray(positionHandle)
        if (uvHandle >= 0) {
            GLES20.glDisableVertexAttribArray(uvHandle)
        }
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
    }

    private class TextTexture(
            val textureId: Int,
            val width: Int,
            val height: Int,
        /**
         * 每个字在**位图**上的左右边界（像素，含左侧 padding），长度 = 字数 + 1。
         * 逐字上浮要按字分别画，就得知道每个字在整行纹理里占哪一段 UV。
         * 整行只有一张纹理，切 UV 比每个字各栅格化一张省得多（不会撑爆纹理缓存）。
         */
            val charBounds: FloatArray) {
        fun dispose() {
            GLES20.glDeleteTextures(1, intArrayOf(textureId), 0)
        }
    }
}
