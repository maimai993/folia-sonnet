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
import java.util.ArrayList;
import java.util.List;

/**
 * 设备侧的 CPU / 内存 / GPU 指标。
 *
 * 桌面端这些数字来自 Electron 的 `app.getAppMetrics()`（`cpu.percentCPUUsage`、
 * `memory.workingSetSize`）和 `nvidia-smi`。安卓上两者都没有，但同样的信息其实都能从
 * 内核里读出来，这个类就是那个读取处：
 *
 *   · CPU 占用 —— **两个口径都给**：
 *     `cpuPercent` / `cpuSystemPercent` 是整机（`/proc/stat` 差分，被 SELinux 挡住时
 *     用 `/proc/loadavg` 折算）；`cpuSelfPercent` 是本应用（`/proc/self/stat` 差分，
 *     与桌面端 `percentCPUUsage` 同口径）。模组问「CPU」要的是整机 —— 单进程读数在
 *     别的进程吃满时只会显示个位数，与用户观感对不上。
 *   · 内存 —— 本进程的 `Pss`（`/proc/self/smaps_rollup`），拿不到就退到 `statm`。
 *   · 温度 —— `/sys/class/thermal/thermal_zone*` 里的 `cpu-*` 与 `gpuss-*`，
 *     取各自 zone 集合的**中位数**（取最大值会被个别坏传感器带偏，见 medianThermal）。
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
            // 本应用占用：桌面端 `percentCPUUsage` 的口径，单进程。
            final double selfPercent = readSelfCpuPercent();
            // 整机占用：模组问「CPU」时想看的那个。`/proc/stat` 读不到时用 loadavg 折算。
            Double systemPercent = readSystemLoadPercent();
            final double cpuPercent = systemPercent == null ? selfPercent : systemPercent;
            final long memoryKb = readMemoryKb(context);

            // 宿主那边（host.js 的 device-metrics 处理）按这几个平铺字段读。
            out.put("cpuPercent", cpuPercent);
            // 两个口径都给出去，模组要哪个都有得挑。
            putNullable(out, "cpuSystemPercent", systemPercent);
            out.put("cpuSelfPercent", selfPercent);
            out.put("memoryKb", memoryKb);

            // 温度：CPU 与 GPU 都取各自 zone 的中位数，电池单独一项。
            putNullable(out, "cpuTempC", medianThermal("cpu-", "cpuss"));
            putNullable(out, "gpuTempC", medianThermal("gpuss"));
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
     * 整机 CPU 占用（0~100）。
     *
     * `/proc/stat` 被 SELinux 挡住时，`/proc/loadavg` 仍然可读 —— 第一项是最近 1 分钟
     * 的可运行任务数均值，也就是「平均有几个核在忙」。除以核数即整机占用率。
     *
     * 这是**整机**口径，和 `readSelfCpuPercent()`（只算本应用）是两件事。
     * 性能卡片要的是这个：用户说「我把 CPU 吃满了」指的是整机，别的进程吃掉的那部分
     * 单进程读数看不见。
     */
    private static Double readSystemLoadPercent() {
        String stat = firstLine("/proc/stat");
        if (stat != null) {
            Double viaStat = readSystemCpuPercent();
            if (viaStat != null) return viaStat;
        }
        String line = firstLine("/proc/loadavg");
        if (line == null) return null;
        String[] parts = line.trim().split("\\s+");
        if (parts.length == 0) return null;
        try {
            double load1 = Double.parseDouble(parts[0]);
            final int cores = Math.max(1, Runtime.getRuntime().availableProcessors());
            return clampPercent(100.0 * load1 / cores);
        } catch (NumberFormatException error) {
            return null;
        }
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
    /**
     * 匹配任一前缀的 thermal zone 温度（摄氏度），**取中位数**而不是最大值。
     *
     * 这台机器（REDMI K80）的 `cpu-*` 有一二十个按核分的 zone，其中个别传感器
     * 读数不可信（偏移未标定、单位不是毫摄氏度）。取 `max` 就等于「哪个传感器坏了
     * 就跟哪个走」——表现是温度飙到早该过热保护的数值，而 `gpuss` 那边正常。
     *
     * 传多个前缀是因为同一颗硅片在不同 zone 里名字不一样：`cpu-1-0-0` 按簇/核分，
     * `cpuss-0` 是子系统级。只认前者会漏掉后者，量出来的温度偏低。
     *
     * 中位数只要求「多数 zone 是好的」，个别离群值带不偏。先按合理区间过滤，
     * 越界的一律丢弃；一个都不剩才回 null（宁可不显示，也不报假数）。
     */
    private static Double medianThermal(String... prefixes) {
        File root = new File("/sys/class/thermal");
        File[] zones = root.listFiles();
        if (zones == null) return null;
        List<Double> readings = new ArrayList<>();
        for (File zone : zones) {
            String name = zone.getName();
            if (!name.startsWith("thermal_zone")) continue;
            String type = readFile(new File(zone, "type").getAbsolutePath());
            if (type == null) continue;
            // 传感器名各厂商不同：同一种硅片上既有 `cpu-1-0-0`（按簇/核）也有 `cpuss-0`
            // （子系统级）。只认前一种会漏掉后者，两者都算才代表整颗 CPU。
            String trimmed = type.trim();
            boolean matched = false;
            for (String prefix : prefixes) {
                if (trimmed.startsWith(prefix)) {
                    matched = true;
                    break;
                }
            }
            if (!matched) continue;
            String raw = readFile(new File(zone, "temp").getAbsolutePath());
            if (raw == null) continue;
            try {
                double celsius = Long.parseLong(raw.trim()) / 1000.0;
                // 手机上的 SoC 温度不会低于 0、也不会到 120；越界的当坏读数丢掉
                // （未接传感器的哨兵值是 -273，某些 zone 还会给出几百）。
                if (celsius < 0 || celsius > 120) continue;
                readings.add(celsius);
            } catch (NumberFormatException ignored) {
                // 下一个 zone。
            }
        }
        if (readings.isEmpty()) return null;
        java.util.Collections.sort(readings);
        int size = readings.size();
        double median = size % 2 == 1
                ? readings.get(size / 2)
                : (readings.get(size / 2 - 1) + readings.get(size / 2)) / 2.0;
        return Math.round(median * 10) / 10.0;
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
