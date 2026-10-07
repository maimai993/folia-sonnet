package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.opengl.GLSurfaceView;
import android.service.wallpaper.WallpaperService;
import android.view.SurfaceHolder;

/**
 * 系统动态壁纸入口。
 *
 * 在 Manifest 里以 BIND_WALLPAPER 权限注册后，它会出现在系统壁纸选择器的「动态壁纸」里，
 * 选中后桌面与锁屏都会用它来绘制。
 *
 * 绘制走 GLSurfaceView：让它替我们管理 EGL 上下文与渲染线程，只需要把 getHolder()
 * 换成引擎自己的 SurfaceHolder（经典的 CubeLiveWallpaper 做法）。
 * 手写 EGL 容易在部分机型上拿到黑屏，这里不冒这个险。
 */
public class LyricsWallpaperService extends WallpaperService {

    @Override
    public void onCreate() {
        super.onCreate();
        // 壁纸可能在应用从未启动过的情况下被系统拉起，先把落盘的歌词读回来。
        WallpaperLyricsState.restore(this);
    }

    @Override
    public Engine onCreateEngine() {
        return new LyricsEngine();
    }

    private final class LyricsEngine extends Engine {

        private WallpaperGlSurfaceView glView;
        private LyricsRenderer renderer;

        @Override
        public void onCreate(SurfaceHolder surfaceHolder) {
            super.onCreate(surfaceHolder);
            // 壁纸不接收触摸：交给桌面处理。
            setTouchEventsEnabled(false);

            renderer = new LyricsRenderer();
            glView = new WallpaperGlSurfaceView(LyricsWallpaperService.this);
            glView.setEGLContextClientVersion(2);
            glView.setPreserveEGLContextOnPause(true);
            glView.setRenderer(renderer);
            glView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        }

        @Override
        public void onVisibilityChanged(boolean visible) {
            super.onVisibilityChanged(visible);
            if (glView == null) {
                return;
            }
            // 看不见就停掉渲染循环，否则息屏后还在烧 CPU。
            if (visible) {
                glView.onResume();
            } else {
                glView.onPause();
            }
        }

        @Override
        public void onOffsetsChanged(float xOffset, float yOffset, float xOffsetStep,
                                     float yOffsetStep, int xPixelOffset, int yPixelOffset) {
            super.onOffsetsChanged(xOffset, yOffset, xOffsetStep, yOffsetStep,
                    xPixelOffset, yPixelOffset);
            if (renderer != null) {
                renderer.setOffsets(xOffset);
            }
        }

        @Override
        public void onDestroy() {
            if (glView != null) {
                glView.onDestroy();
            }
            super.onDestroy();
        }

        /**
         * 把 GLSurfaceView 绑到壁纸的 Surface 上：它内部会拿 getHolder() 去监听 surface 生命周期，
         * 所以这里必须返回引擎的 holder 而不是自己的。
         *
         * 必须是 Engine 的内部类、且直接调 getSurfaceHolder()：
         * GLSurfaceView 的构造函数内部就会调 init() → getHolder() 注册回调，
         * 早于任何字段赋值的时机。用构造参数传 holder 的话，此刻字段还是 null，
         * 一取就是 NullPointerException —— 而壁纸与应用同进程，这一崩就是整个进程崩，
         * 表现出来就是「设了壁纸之后应用再也打不开」。
         */
        private final class WallpaperGlSurfaceView extends GLSurfaceView {

            WallpaperGlSurfaceView(Context context) {
                super(context);
            }

            @Override
            public SurfaceHolder getHolder() {
                return getSurfaceHolder();
            }

            void onDestroy() {
                super.onDetachedFromWindow();
            }
        }
    }

    /**
     * 把 GLSurfaceView 绑到壁纸的 Surface 上：它内部会拿 getHolder() 去监听 surface 生命周期，
     * 所以这里必须返回引擎的 holder 而不是自己的。
     */
}
