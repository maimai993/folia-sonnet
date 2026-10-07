package top.izuna.foliamajor.wallpaper;

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

    private static final String TAG = "LyricsRenderer";
    /** 一次最多画这么多行（当前行各向上下展开）。 */
    private static final int VISIBLE_SPAN = 3;
    private static final int TEXTURE_CACHE_LIMIT = 24;

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

    private float animatedIndex = 0f;
    private float animatedProgress = 0f;
    private long lastNanos = 0L;
    private float elapsedSeconds = 0f;

    private int coverTexture = 0;
    private boolean coverUploaded = false;

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

    @Override
    public void onDrawFrame(GL10 gl) {
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

        // 行号做插值：换行时平滑滑过去，而不是硬跳。
        animatedProgress = approach(animatedProgress, computedProgress, deltaSeconds, 6f);
        float targetIndex = computedIndex;
        // 换歌或拖动进度条造成的跳变直接对齐，不要缓慢地滑过去。
        if (Math.abs(targetIndex - animatedIndex) > 2.5f) {
            animatedIndex = targetIndex;
            animatedProgress = computedProgress;
        } else {
            animatedIndex = approach(animatedIndex, targetIndex, deltaSeconds, 7f);
        }

        accentTarget = rgbFromColor(snapshot.accent);
        baseTarget = rgbFromColor(snapshot.baseColor);
        motionTarget = snapshot.motion;
        float blend = Math.min(1f, deltaSeconds * 3f);
        for (int i = 0; i < 3; i++) {
            accent[i] += (accentTarget[i] - accent[i]) * blend;
            base[i] += (baseTarget[i] - base[i]) * blend;
        }
        motion += (motionTarget - motion) * blend;

        syncCover(snapshot.cover);

        GLES20.glClearColor(0.02f, 0.02f, 0.03f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);

        drawBackground();
        if ("cover".equals(snapshot.backgroundMode)) {
            drawCover();
        }
        drawLyrics(snapshot);
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
        GLES20.glUniform1f(GLES20.glGetUniformLocation(backgroundProgram, "uMotion"), motion);
        GLES20.glUniform4f(GLES20.glGetUniformLocation(backgroundProgram, "uRect"),
                -1f, -1f, 2f, 2f);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        unbindQuad(position, uv);
        GLES20.glEnable(GLES20.GL_BLEND);
    }

    private void drawCover() {
        if (coverTexture == 0 || quadProgram == 0) {
            return;
        }
        drawTexturedQuad(coverTexture, 0f, 0f, surfaceWidth, surfaceHeight,
                1f, 1f, 1f, 0.28f, -1f, 1f);
    }

    // ---- 歌词 ----

    private void drawLyrics(WallpaperLyricsState.Snapshot snapshot) {
        if (quadProgram == 0) {
            return;
        }
        if (snapshot.isEmpty()) {
            return;
        }

        float baseFontPx = clamp(surfaceHeight * 0.062f, 26f, 84f);
        float lineStep = surfaceHeight * 0.115f;
        float centerY = surfaceHeight * 0.47f;
        float maxWidth = surfaceWidth * 0.84f;

        int first = Math.max(0, (int) Math.floor(animatedIndex) - VISIBLE_SPAN);
        int last = Math.min(snapshot.lines.length - 1,
                (int) Math.ceil(animatedIndex) + VISIBLE_SPAN);

        for (int i = first; i <= last; i++) {
            String text = snapshot.lines[i].text;
            if (text == null || text.trim().isEmpty()) {
                continue;
            }
            float distance = Math.abs(i - animatedIndex);
            if (distance > VISIBLE_SPAN + 0.5f) {
                continue;
            }

            TextTexture texture = textureFor(text, Math.round(baseFontPx));
            if (texture == null) {
                continue;
            }

            float scale = 1f - Math.min(0.30f, 0.13f * distance);
            float width = texture.width * scale;
            float height = texture.height * scale;
            if (width > maxWidth) {
                float fit = maxWidth / width;
                width *= fit;
                height *= fit;
            }
            float alpha = clamp(1f - 0.30f * distance, 0f, 1f);
            float y = centerY + (i - animatedIndex) * lineStep;

            boolean isCurrent = distance < 0.5f;
            // 逐字高亮：按行内进度在纹理上做横向擦除。
            float progress = isCurrent ? clamp(animatedProgress, 0f, 1f) : -1f;

            drawCentered(texture, y, width, height, alpha, progress);
        }
    }

    private void drawCentered(TextTexture texture, float centerYPx, float widthPx, float heightPx,
                              float alpha, float progress) {
        float left = (surfaceWidth - widthPx) * 0.5f;
        float top = centerYPx - heightPx * 0.5f;
        // 未唱到的字用暗白，唱过的用纯白，擦除边缘补一点主题色的光。
        drawTexturedQuad(texture.textureId, left, top, widthPx, heightPx,
                0.62f, 0.66f, 0.72f, alpha, progress, 0f);
    }

    private void drawTexturedQuad(int textureId, float leftPx, float topPx, float widthPx,
                                  float heightPx, float r, float g, float b, float alpha,
                                  float progress, float useTextureColor) {
        if (quadProgram == 0) {
            return;
        }
        GLES20.glUseProgram(quadProgram);

        int position = GLES20.glGetAttribLocation(quadProgram, "aPosition");
        int uv = GLES20.glGetAttribLocation(quadProgram, "aUv");
        bindQuad(position, uv);

        // 像素坐标 → NDC（y 轴翻转）。
        float x = (leftPx / surfaceWidth) * 2f - 1f;
        float y = 1f - (topPx / surfaceHeight) * 2f;
        float w = (widthPx / surfaceWidth) * 2f;
        float h = (heightPx / surfaceHeight) * 2f;
        GLES20.glUniform4f(GLES20.glGetUniformLocation(quadProgram, "uRect"), x, y, w, h);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uColor"), r, g, b);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uActive"), 1f, 1f, 1f);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(quadProgram, "uGlow"),
                accent[0], accent[1], accent[2]);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uAlpha"), alpha);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(quadProgram, "uProgress"), progress);
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
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
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
        TextTexture texture = new TextTexture(textureId, bitmapWidth, bitmapHeight);
        textures.put(key, texture);
        return texture;
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
        Bitmap blurred = blurredCover(decoded);
        coverTexture = upload(blurred);
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
            // 封面可能很大，先压到 512 再模糊，避免上传一张几千像素的纹理。
            int edge = Math.max(source.getWidth(), source.getHeight());
            if (edge > 512) {
                float ratio = 512f / edge;
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

    /** 缩到 24px 再放大回来，用一个廉价手段近似高斯模糊。 */
    static Bitmap blurredCover(Bitmap source) {
        try {
            int small = 24;
            Bitmap tiny = Bitmap.createScaledBitmap(source, small, small, true);
            return Bitmap.createScaledBitmap(tiny, source.getWidth() / 2, source.getHeight() / 2, true);
        } catch (Throwable error) {
            Log.w(TAG, "Blur failed; using the raw cover", error);
            return source;
        }
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

        TextTexture(int textureId, int width, int height) {
            this.textureId = textureId;
            this.width = width;
            this.height = height;
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
            + "void main() {\n"
            + "  vec2 p = vec2(vUv.x * uAspect, vUv.y);\n"
            + "  float t = uTime * 0.06 * uMotion;\n"
            + "  vec2 c1 = vec2((0.30 + 0.12 * sin(t * 1.1) + uOffsetX * 0.12) * uAspect,"
            + " 0.26 + 0.10 * cos(t * 0.9));\n"
            + "  vec2 c2 = vec2((0.72 + 0.10 * cos(t * 0.8) + uOffsetX * 0.12) * uAspect,"
            + " 0.72 + 0.12 * sin(t * 1.3));\n"
            + "  float g1 = smoothstep(0.95, 0.0, distance(p, c1));\n"
            + "  float g2 = smoothstep(0.95, 0.0, distance(p, c2));\n"
            + "  vec3 col = uBase + uAccent * (g1 * 0.42 + g2 * 0.28);\n"
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
            + "  col += vec3(0.55, 0.58, 0.68) * dust * 0.16;\n"
            + "  float vignette = smoothstep(1.25, 0.30, distance(vUv, vec2(0.5)));\n"
            + "  col *= mix(0.52, 1.0, vignette);\n"
            + "  gl_FragColor = vec4(col, 1.0);\n"
            + "}\n";

    private static final String QUAD_VERTEX =
            "attribute vec2 aPosition;\n"
            + "attribute vec2 aUv;\n"
            + "uniform vec4 uRect;\n"
            + "varying vec2 vUv;\n"
            + "void main() {\n"
            // 位图第 0 行在顶部，纹理坐标 v=0 在底部，所以要翻过来。
            + "  vUv = vec2(aUv.x, 1.0 - aUv.y);\n"
            + "  vec2 ndc = uRect.xy + aPosition * uRect.zw;\n"
            + "  gl_Position = vec4(ndc, 0.0, 1.0);\n"
            + "}\n";

    private static final String QUAD_FRAGMENT =
            "precision mediump float;\n"
            + "varying vec2 vUv;\n"
            + "uniform sampler2D uTexture;\n"
            + "uniform vec3 uColor;\n"
            + "uniform vec3 uActive;\n"
            + "uniform vec3 uGlow;\n"
            + "uniform float uAlpha;\n"
            + "uniform float uProgress;\n"
            + "uniform float uUseTexColor;\n"
            + "void main() {\n"
            + "  vec4 tex = texture2D(uTexture, vUv);\n"
            + "  float a = tex.a * uAlpha;\n"
            + "  vec3 rgb = mix(uColor, tex.rgb, uUseTexColor);\n"
            + "  if (uProgress >= 0.0) {\n"
            + "    float edge = smoothstep(uProgress - 0.010, uProgress + 0.010, vUv.x);\n"
            + "    rgb = mix(uActive, rgb, edge);\n"
            + "    float glow = exp(-pow((vUv.x - uProgress) * 70.0, 2.0));\n"
            + "    rgb += uGlow * glow * 0.55;\n"
            + "  }\n"
            // 位图是预乘 alpha 的，这里按预乘输出，配合 blendFunc(ONE, 1-SRC_ALPHA)。
            + "  gl_FragColor = vec4(rgb * a, a);\n"
            + "}\n";
}
