package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 壁纸自选背景图的落盘副本。
 *
 * 之前把 base64 整串挂在进程内的歌词状态上传递，看着最省事，实际有三个地方会掉：
 * 应用进程被回收后状态清空；壁纸服务由系统按需绑定、绑定时机可能晚于应用推送；
 * 几百 KB 的字符串每次换歌都要重新过一遍桥。
 *
 * 改成**只落一个文件**：Web 侧选好图之后原生立刻解码写成 JPEG，之后谁要画都直接读文件。
 * 文件本身就是持久化，进程怎么重启都在；状态里只留一个很轻的 key（长度 + 修改时间），
 * 渲染器拿它判断「图换没换过」。
 */
public final class WallpaperBackgroundImage {

    private static final String TAG = "FoliaWallpaper";
    private static final String FILE_NAME = "folia_wallpaper_background.jpg";
    /**
     * 只是防御性上限：壁纸要铺满一整屏，图本身必须比屏幕大，否则放大上去就是一团糊。
     * Web 侧已经按壁纸的用途单独压过一遍（不是封面那张 256 的小图），这里不再主动缩。
     */
    private static final int MAX_EDGE = 2560;
    private static final int JPEG_QUALITY = 92;

    private WallpaperBackgroundImage() {}

    private static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    /**
     * 写入（或清除）自选背景图。
     * @return 当前图的 key；没有图时返回 null。
     */
    public static String store(Context context, String base64) {
        if (context == null) {
            return null;
        }
        File file = file(context);
        if (base64 == null || base64.trim().isEmpty()) {
            delete(file);
            return null;
        }
        Bitmap decoded = decode(base64);
        if (decoded == null) {
            Log.w(TAG, "Failed to decode the chosen wallpaper background image");
            return key(context);
        }
        Bitmap scaled = downscale(decoded);
        boolean written = false;
        try (FileOutputStream out = new FileOutputStream(file)) {
            written = scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
        } catch (IOException | RuntimeException error) {
            Log.w(TAG, "Failed to persist the wallpaper background image", error);
        }
        if (scaled != decoded) {
            scaled.recycle();
        }
        decoded.recycle();
        if (!written) {
            delete(file);
        }
        return key(context);
    }

    /** 图换没换过的判据：文件长度 + 修改时间。够轻，也不必另存一份指纹。 */
    public static String key(Context context) {
        if (context == null) {
            return null;
        }
        File file = file(context);
        if (!file.exists() || file.length() <= 0) {
            return null;
        }
        return file.length() + "@" + file.lastModified();
    }

    /** 读回背景图。调用方负责 recycle。 */
    public static Bitmap load(Context context) {
        if (context == null) {
            return null;
        }
        File file = file(context);
        if (!file.exists()) {
            return null;
        }
        return BitmapFactory.decodeFile(file.getAbsolutePath());
    }

    private static void delete(File file) {
        try {
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "Failed to delete the wallpaper background image");
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Failed to delete the wallpaper background image", error);
        }
    }

    private static Bitmap decode(String base64) {
        try {
            int comma = base64.indexOf(',');
            String payload = comma >= 0 ? base64.substring(comma + 1) : base64;
            byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null || bitmap.getWidth() < 2 || bitmap.getHeight() < 2) {
                return null;
            }
            return bitmap;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to decode the wallpaper background image", error);
            return null;
        }
    }

    private static Bitmap downscale(Bitmap source) {
        int edge = Math.max(source.getWidth(), source.getHeight());
        if (edge <= MAX_EDGE) {
            return source;
        }
        float ratio = (float) MAX_EDGE / edge;
        return Bitmap.createScaledBitmap(source,
                Math.max(1, Math.round(source.getWidth() * ratio)),
                Math.max(1, Math.round(source.getHeight() * ratio)), true);
    }
}
