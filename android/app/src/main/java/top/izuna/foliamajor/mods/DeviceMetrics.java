package top.izuna.foliamajor.mods;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * 设备侧的 CPU / 内存 / GPU 指标。
 *
 * 桌面端这些数字来自 Electron 的 `app.getAppMetrics()`（`cpu.percentCPUUsage`、
 * `memory.workingSetSize`）和 `nvidia-smi`。安卓上两者都没有，但同样的信息其实都能从
 * 内核里读出来，这个类就是那个读取处：
 *
 *   · CPU 占用 —— `/proc/stat` 两次采样的差值。绝对计数器必须差分才有意义，
 *     所以这里记住上一次的快照，第一次调用给 0%（和桌面端「先打一次底」同理）。
 *   · 内存 —— 本进程的 `Pss`（`/proc/self/smaps_rollup`），拿不到就退到 `statm`。
 *   · 温度 —— `/sys/class/thermal/thermal_zone*` 里的 `cpu-*` 与 `gpuss-*`。
 *     毫摄氏度，负值（未接传感器，常见 -273000）直接丢掉。
 *   · GPU 占用 —— 安卓没有通用接口，按项目决定用整机 CPU 占用近似。
 *
 * 读不到的一律给 null 而不是 0：0% 和「不知道」在界面上是两件事。
 */
final class DeviceMetrics {

    private static final String TAG = "FoliaMetrics";

    /** 上一次 `/proc/stat` 的 (总 jiffies, 空闲 jiffies)；差分用。 */
    private static long lastTotal = -1;
    private static long lastIdle = -1;

    /** 上一次本进程的 CPU jiffies 与墙钟（见 readSelfCpuPercent）。 */
    private static long lastSelfTicks = -1;
    private static long lastSelfAt = -1;

    private DeviceMetrics() {}

    /**
     * 采一份指标。返回的 JSON 字段与桌面端 `app.getAppMetrics()` 的两项对齐
     * （`cpu.percentCPUUsage` / `memory.workingSetSize`，后者是 KB），
     * 外加桌面端没有、这里能给的温度。
     */
    static JSONObject snapshot(Context context) {
        JSONObject out = new JSONObject();
        try {
            final double cpuPercent = readCpuPercent();
            final long memoryKb = readMemoryKb(context);

            // 宿主那边（host.js 的 device-metrics 处理）按这几个平铺字段读。
            out.put("cpuPercent", cpuPercent);
            out.put("memoryKb", memoryKb);

            // 温度：CPU 取各核最大值，GPU 取 gpuss，电池单独一项。
            putNullable(out, "cpuTempC", maxThermal("cpu-"));
            putNullable(out, "gpuTempC", maxThermal("gpuss"));
            putNullable(out, "batteryTempC", readBatteryTempC(context));
            putNullable(out, "batteryLevel", readBatteryLevel(context));

            // GPU 占用：安卓没有通用接口，按约定用整机 CPU 占用近似（见类注释）。
            out.put("gpuUtilPct", cpuPercent);
            out.put("gpuName", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
            // 诊断用：release 包里 Log.d 会被过滤，把原始计数器一并带出去便于核对。
            out.put("_cpuTotal", lastTotal);
            out.put("_cpuIdle", lastIdle);
            final String globalStat = firstLine("/proc/stat");
            final String selfStat = firstLine("/proc/self/stat");
            final String loadAvg = firstLine("/proc/loadavg");
            out.put("_statHead", globalStat == null ? "(null)" : globalStat.substring(0, Math.min(40, globalStat.length())));
            out.put("_selfHead", selfStat == null ? "(null)" : selfStat.substring(0, Math.min(40, selfStat.length())));
            out.put("_load", loadAvg == null ? "(null)" : loadAvg);
        } catch (Throwable error) {
            Log.w(TAG, "采集设备指标失败", error);
        }
        return out;
    }

    /** 值为 null 时写 JSON 的 null（而不是跳过），宿主据此区分「不知道」和「0」。 */
    private static void putNullable(JSONObject target, String key, Object value) throws JSONException {
        target.put(key, value == null ? JSONObject.NULL : value);
    }

    /**
     * 整机 CPU 占用百分比。
     *
     * 首选 `/proc/stat` 的差分（那是真正的整机口径）。但 **Android 10 起 SELinux 把
     * `proc_stat` 挡在应用域之外**，普通应用打开会直接失败 —— 所以再退一层：用本进程
     * 的 CPU 时间（`/proc/self/stat`，自有文件，一定可读）除以墙钟时间，再按核数归一。
     * 这条退路给出的是「本应用占整机多少」，和桌面端 `app.getAppMetrics()` 的口径
     * 其实一致（那也是单个进程的占用），只是拿不到别的进程。
     */
    private static synchronized double readCpuPercent() {
        Double system = readSystemCpuPercent();
        if (system != null) return system;
        return readSelfCpuPercent();
    }

    /** `/proc/stat` 差分。读不到（SELinux）或首次采样时回 null。 */
    private static Double readSystemCpuPercent() {
        String line = firstLine("/proc/stat");
        if (line == null || !line.startsWith("cpu ")) return null;
        String[] parts = line.trim().split("\\s+");
        if (parts.length < 5) return null;
        long total = 0;
        for (int i = 1; i < parts.length && i <= 8; i++) {
            total += parse(parts[i]);
        }
        long idle = parse(parts[4]) + (parts.length > 5 ? parse(parts[5]) : 0);
        if (lastTotal < 0) {
            lastTotal = total;
            lastIdle = idle;
            return null;
        }
        long deltaTotal = total - lastTotal;
        long deltaIdle = idle - lastIdle;
        lastTotal = total;
        lastIdle = idle;
        if (deltaTotal <= 0) return null;
        return clampPercent(100.0 * (deltaTotal - deltaIdle) / deltaTotal);
    }

    /**
     * 本进程 CPU 占用。`/proc/self/stat` 的第 14/15 项是 utime/stime（jiffies）。
     *
     * 除以「墙钟 × 核数」得到占整机的比例 —— 单线程满载在 8 核机器上约 12.5%，
     * 与桌面端 `percentCPUUsage`（也是按整机归一）的读法一致。
     */
    private static synchronized double readSelfCpuPercent() {
        String line = firstLine("/proc/self/stat");
        if (line == null) return 0;
        // comm 字段带括号且可能含空格，从右括号之后开始切才安全。
        int close = line.lastIndexOf(')');
        if (close < 0 || close + 2 >= line.length()) return 0;
        String[] fields = line.substring(close + 2).trim().split("\\s+");
        // 右括号之后第 1 项是 state，所以 utime 在 index 11、stime 在 12。
        long ticks = parse(indexOf(fields, 11)) + parse(indexOf(fields, 12));
        long now = SystemClock.elapsedRealtime();
        if (lastSelfTicks < 0 || lastSelfAt < 0) {
            lastSelfTicks = ticks;
            lastSelfAt = now;
            return 0;
        }
        long deltaTicks = ticks - lastSelfTicks;
        long deltaMs = now - lastSelfAt;
        lastSelfTicks = ticks;
        lastSelfAt = now;
        if (deltaTicks < 0 || deltaMs <= 0) return 0;
        // 一个 jiffy 默认 10ms（USER_HZ=100）。
        double cpuMs = deltaTicks * 10.0;
        final int cores = Math.max(1, Runtime.getRuntime().availableProcessors());
        return clampPercent(100.0 * cpuMs / (deltaMs * cores));
    }

    private static String indexOf(String[] values, int index) {
        return index >= 0 && index < values.length ? values[index] : "0";
    }

    private static double clampPercent(double value) {
        if (value < 0) return 0;
        if (value > 100) return 100;
        return Math.round(value * 10) / 10.0;
    }

    private static long parse(String value) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    /**
     * 本进程占用的内存（KB）。
     *
     * 优先 `smaps_rollup` 的 `Pss`（最贴近「实际占用」）；老内核没有这个文件时退到
     * `statm` 的驻留页数，最后用 `ActivityManager` 的内存信息兜底。
     */
    private static long readMemoryKb(Context context) {
        String rollup = readFile("/proc/self/smaps_rollup");
        if (rollup != null) {
            for (String row : rollup.split("\n")) {
                if (!row.startsWith("Pss:")) continue;
                String digits = row.replaceAll("[^0-9]", "");
                if (!digits.isEmpty()) {
                    try {
                        return Long.parseLong(digits);
                    } catch (NumberFormatException ignored) {
                        // 落到底下几种读法。
                    }
                }
            }
        }
        String statm = readFile("/proc/self/statm");
        if (statm != null) {
            String[] fields = statm.trim().split("\\s+");
            // 第二项是驻留页数。
            if (fields.length >= 2) {
                try {
                    long pages = Long.parseLong(fields[1]);
                    return pages * (android.os.Build.VERSION.SDK_INT >= 16 ? 4096L : 4096L) / 1024L;
                } catch (NumberFormatException ignored) {
                    // 继续兜底。
                }
            }
        }
        try {
            ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager != null) {
                ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
                manager.getMemoryInfo(info);
                return (info.totalMem - info.availMem) / 1024L;
            }
        } catch (Throwable error) {
            Log.w(TAG, "读内存失败", error);
        }
        return 0;
    }

    /**
     * 匹配前缀的 thermal zone 里最高的那个温度（摄氏度）。
     *
     * 节点单位是毫摄氏度；`-273000` 这类是「未接传感器」的哨兵值，必须丢掉，
     * 否则算出来的最大值永远是 -273°C。
     */
    private static Double maxThermal(String prefix) {
        File root = new File("/sys/class/thermal");
        File[] zones = root.listFiles();
        if (zones == null) return null;
        double best = Double.NEGATIVE_INFINITY;
        for (File zone : zones) {
            String name = zone.getName();
            if (!name.startsWith("thermal_zone")) continue;
            String type = readFile(new File(zone, "type").getAbsolutePath());
            if (type == null || !type.trim().startsWith(prefix)) continue;
            String raw = readFile(new File(zone, "temp").getAbsolutePath());
            if (raw == null) continue;
            try {
                double celsius = Long.parseLong(raw.trim()) / 1000.0;
                // 低于 -40 或高于 200 的一律当成坏读数。
                if (celsius < -40 || celsius > 200) continue;
                if (celsius > best) best = celsius;
            } catch (NumberFormatException ignored) {
                // 下一个 zone。
            }
        }
        if (best == Double.NEGATIVE_INFINITY) return null;
        return Math.round(best * 10) / 10.0;
    }

    /** 电池温度（摄氏度）。安卓的 `EXTRA_TEMPERATURE` 是 0.1°C 为单位。 */
    private static Double readBatteryTempC(Context context) {
        try {
            Intent intent = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return null;
            int tenths = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (tenths == Integer.MIN_VALUE || tenths <= 0) return null;
            return Math.round(tenths / 10.0 * 10) / 10.0;
        } catch (Throwable error) {
            Log.w(TAG, "读电池温度失败", error);
            return null;
        }
    }

    private static Integer readBatteryLevel(Context context) {
        try {
            Intent intent = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return null;
            int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            return level < 0 ? null : level;
        } catch (Throwable error) {
            return null;
        }
    }

    private static String firstLine(String path) {
        String text = readFile(path);
        if (text == null) return null;
        int end = text.indexOf('\n');
        return end < 0 ? text : text.substring(0, end);
    }

    /**
     * 读一个文本文件；不存在或读不了回 null（调用方据此判断「没有这项」）。
     *
     * 必须用流式读：`/proc` 下的文件是内核现生成的，长度报 0、不支持随机访问，
     * 用 `RandomAccessFile` 读只会拿到空内容（之前 CPU 恒为 0 就是踩了这个）。
     */
    private static String readFile(String path) {
        InputStream stream = null;
        try {
            stream = new FileInputStream(path);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(4096);
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
                // procfs 的文件可能无限长（/proc/kmsg 之类），这里只关心前几十行。
                if (buffer.size() > 64 * 1024) break;
            }
            if (buffer.size() == 0) return null;
            return buffer.toString("UTF-8");
        } catch (Throwable error) {
            return null;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Throwable ignored) {
                    // 关闭失败无所谓。
                }
            }
        }
    }
}
