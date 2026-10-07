package top.izuna.foliamajor;

import android.app.Application;

/**
 * 让崩溃取证覆盖到「MainActivity 还没起来」的那段时间。
 *
 * 动态壁纸与应用同进程，而壁纸引擎是系统直接拉起的：它可能比 Activity 更早跑，
 * 那时装在 MainActivity.onCreate 里的处理器还没生效，崩了就是无声的进程死亡 ——
 * 用户看到的只是「应用打不开」，拿不到任何线索。
 *
 * 装在这里，进程内任何一处未捕获异常都会被记下来并弹崩溃界面。
 */
public class FoliaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        FoliaCrashHandler.install(this);
    }
}
