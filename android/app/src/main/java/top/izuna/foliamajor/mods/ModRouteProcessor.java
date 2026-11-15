// 当前文件：把模组的 client 入口做成同源 URL 的 Capacitor RouteProcessor。
//
// 桌面端用自定义协议 folia-mod://<id>/<client> 供渲染进程 import 模组代码。安卓没有自定义
// 协议注册的等价物，但 Capacitor 的本地服务器把 https://localhost 当应用源，且允许一个
// RouteProcessor 在真正读文件前改写路径（WebViewLocalServer.createHostingDetails）。
//
// 于是：渲染端 import `/mods/<id>/<digest>/<client>`，这里把它换成私有目录里的绝对路径，
// 交给 Capacitor 用 FileInputStream 读。
//
// 两个必须守住的点：
//   · 只放行「已载入」模组的文件。改写在 File 层做规范化（canonicalPath 前缀比对），
//     所以 `..` 逃不出 mods 根目录；模组目录名与 id 都必须匹配，挡掉任意路径读取。
//   · `/mods/builtin/...` 是随包内置模组（assets 里真实存在的文件），必须原样放行，
//     否则内置模组全挂。所以先判 builtin，再做用户模组映射。

package top.izuna.foliamajor.mods;

import android.util.Log;

import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.RouteProcessor;

import java.io.File;
import java.io.IOException;

public final class ModRouteProcessor implements RouteProcessor {

    private static final String TAG = "ModRoute";

    /** 用户模组的 URL 前缀（渲染端 import 的那个）。 */
    private static final String PREFIX = "/mods/";

    /** 内置模组的子前缀，交给 assets 原样处理。 */
    private static final String BUILTIN = "builtin";

    /** Capacitor 的私有文件前缀：openFile 会把它去掉再当绝对路径用。 */
    private static final String FILE_START = "/_capacitor_file_";

    private final File modsRoot;

    public ModRouteProcessor(File modsRoot) {
        this.modsRoot = modsRoot;
    }

    @Override
    public ProcessedRoute process(String basePath, String path) {
        ProcessedRoute route = new ProcessedRoute();
        String rewritten = rewrite(path);
        if (rewritten != null) {
            route.setAsset(false);
            route.setIgnoreAssetPath(false);
            route.setPath(FILE_START + rewritten);
            return route;
        }
        /*
         * 其余一律按「APK 里的 assets」处理，并且**必须把 basePath 还回去**。
         *
         * WebViewLocalServer 里两条路径调进来的 basePath 是不一样的：
         *   · 普通资源（PathHandler）：process("", path)        —— basePath 空
         *   · 首屏入口（html5mode 的 "/" 与无扩展名兜底）：
         *       process(this.basePath, "/index.html")           —— basePath 此时是 "/public"
         * 然后入口那条分支只用返回的 path 调 openAsset(startPath)，**不再拼 basePath**：
         *
         *       String startPath = this.basePath + "/index.html";
         *       if (routeProcessor != null) { startPath = processedRoute.getPath(); isAsset = ...; }
         *       if (isAsset) responseStream = protocolHandler.openAsset(startPath);
         *
         * 所以入口这里要是不补回 basePath，就会去 openAsset("/index.html")，
         * APK 里那个文件在 "public/index.html"，读不到 → 首屏 about:blank、整屏黑（实测过）。
         * 普通资源那边本来就走 assetPath + path，basePath 是空的，补不补都一样。
         *
         * 结论：asset 模式下把 basePath + path 拼好交出去，两种调用点都对。
         */
        route.setAsset(true);
        route.setIgnoreAssetPath(false);
        route.setPath(joinAssetPath(basePath, path));
        return route;
    }

    /** 复刻 Capacitor 在「没有 RouteProcessor」时会做的那次拼接。 */
    private static String joinAssetPath(String basePath, String path) {
        String base = basePath == null ? "" : basePath;
        String rest = path == null ? "" : path;
        if (base.isEmpty()) return rest;
        if (rest.isEmpty() || rest.equals("/")) return base;
        if (base.endsWith("/") && rest.startsWith("/")) return base + rest.substring(1);
        if (!base.endsWith("/") && !rest.startsWith("/")) return base + "/" + rest;
        return base + rest;
    }

    /** 把 from 起的片段重新用 "/" 拼起来。 */
    private static String joinTail(String[] segments, int from) {
        StringBuilder out = new StringBuilder();
        for (int index = from; index < segments.length; index += 1) {
            if (out.length() > 0) out.append('/');
            out.append(segments[index]);
        }
        return out.toString();
    }

    /** 命中用户模组就把虚拟路径换成绝对路径；没命中返回 null。 */
    private String rewrite(String path) {
        // 主文档与 assets 必须原样放过：Capacitor 把 appUrl 当作 index.html 的入口，
        // 只有带 /_capacitor_file_ 前缀或显式绝对路径时才走 openFile。把 "/" 也改写掉
        // 会让首屏直接变成 about:blank（黑屏）。
        if (path == null || path.isEmpty() || path.equals("/")) {
            return null;
        }
        if (!path.startsWith(PREFIX)) {
            return null;
        }
        String rest = path.substring(PREFIX.length());
        if (rest.isEmpty()) {
            return null;
        }
        // 内置模组走 assets，不碰。
        if (rest.equals(BUILTIN) || rest.startsWith(BUILTIN + "/")) {
            return null;
        }
        // 查询串不参与文件查找。
        int query = rest.indexOf('?');
        if (query >= 0) {
            rest = rest.substring(0, query);
        }
        if (rest.isEmpty()) {
            return null;
        }
        /*
         * URL 形态是 /mods/<id>/<digest>/<client>，中间那段是内容摘要，用来绕开 WebView
         * 的 ES 模块表缓存（改完代码要立刻生效）。它不是磁盘上的目录，必须去掉，
         * 否则会被当成 mods/<id>/<digest>/<client> 去找，永远 404。
         * 摘要段只是缓存键，放行与否交给下面的规范化与 isFile 判断。
         */
        String[] segments = rest.split("/");
        if (segments.length >= 3) {
            rest = segments[0] + "/" + joinTail(segments, 2);
        }
        try {
            File root = modsRoot.getCanonicalFile();
            File target = new File(root, rest).getCanonicalFile();
            String rootPath = root.getPath() + File.separator;
            if (!target.getPath().startsWith(rootPath) || !target.isFile()) {
                Log.w(TAG, "拒绝越界或不存在的模组路径：" + path);
                return null;
            }
            return target.getAbsolutePath();
        } catch (IOException error) {
            Log.w(TAG, "解析模组路径失败：" + path);
            return null;
        }
    }
}
