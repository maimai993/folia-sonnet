package top.izuna.foliamajor

/*
 * 局域网发现的**策略**（issue M21）：发什么、什么时候补发兜底、等待窗口多长、回取描述用多少预算。
 *
 * 过去这些数字散在 FoliaLanCastPlugin 的循环里，写死成一个固定节拍：每 400ms 轮换一个搜索目标，
 * `MediaRenderer` / `AVTransport` / `ssdp:all` 无条件轮转，不管有没有搜到。两个后果：
 *
 * - 网络里只有一台音响时也在反复广播 `ssdp:all`，把同网段的 NAS、打印机、路由器全叫醒一遍；
 * - 等待窗口 400ms 而 M-SEARCH 声明 `MX: 2`（允许设备在 2 秒内的任意时刻应答）。声明 2 秒却
 *   只等 400ms，属于用重发掩盖协议错配：慢设备要么被漏掉，要么靠运气撞上下一轮；
 * - 每应答一台就串行 GET 一次设备描述，连接 4s / 读 6s，`timeoutMs` 完全管不到这一段 ——
 *   一台不响应的设备就能把「搜音响」拖到十几秒。
 *
 * 这一层只算策略、不发包，判定都能在 JVM 单元测试里钉住。
 */
internal object LanCastDiscovery {

    const val MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
    const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
    const val ALL = "ssdp:all"

    /**
     * 一轮的等待窗口，与 M-SEARCH 的 `MX` 声明严格对齐。
     *
     * 声明的 MX 是多少，就必须等多久 —— 否则设备按协议在窗口内正常应答反而被丢。
     * 2 秒也是 UPnP 设备实现里最常见的节拍（不少固件按 `MX` 拖满才回）。
     */
    const val MX_SECONDS = 2
    const val WINDOW_MS = MX_SECONDS * 1000

    /** 精准搜索的第几轮仍零结果时，才补发 `ssdp:all`。 */
    const val FALLBACK_AFTER_ROUNDS = 1

    /** 回取描述的整体预算上限：再慢也不能让「搜音响」等过这个数。 */
    const val MAX_FETCH_BUDGET_MS = 6_000

    /** 回取描述的并发上限：家用路由器扛不住十几条并发 TLS/HTTP。 */
    const val MAX_FETCH_CONCURRENCY = 4

    /** 单台设备回取描述的预算。超时的设备按「跳过」处理，不拖累其它设备。 */
    const val PER_DEVICE_FETCH_BUDGET_MS = 2_500

    /** 一次搜索任务：发哪个 ST，等多久。 */
    data class Probe(val searchTarget: String, val windowMs: Int)

    /**
     * 第一轮的探针：只问 MediaRenderer，**不发** `ssdp:all`。
     *
     * 只在网络里一台 MediaRenderer 都没有时才有必要把全网段叫醒（见 [fallback]）。
     */
    fun precise(): Probe = Probe(MEDIA_RENDERER, WINDOW_MS)

    /** 精准搜索零结果后的兜底探针。 */
    fun fallback(): Probe = Probe(ALL, WINDOW_MS)

    /**
     * 还要不要继续发探针。
     *
     * @param elapsedMs 已经花掉的时间
     * @param timeoutMs 对外承诺的总时长（`discover` 的 `timeoutMs`）
     * @param found 目前读成设备的台数
     * @param rounds 已经发过几轮
     * @param preciseRoundsWithoutResult 精准搜索连续几轮零结果
     */
    fun nextProbe(
        elapsedMs: Long,
        timeoutMs: Int,
        found: Int,
        rounds: Int,
        preciseRoundsWithoutResult: Int,
    ): Probe? {
        // 连一轮都装不下就别发了：发了也收不到回复，白叫醒全网段。
        if (elapsedMs + WINDOW_MS > timeoutMs) return null
        // 已经搜到了就不必再广播：多一轮只会让全网段再应答一次。
        if (found > 0) return null
        return if (preciseRoundsWithoutResult >= FALLBACK_AFTER_ROUNDS) fallback() else precise()
    }

    /**
     * 回取设备描述的整体预算。
     *
     * `timeoutMs` 只管抓包，过去回取这一段完全不受约束：每台设备串行 GET，连接 4s、读 6s，
     * 十台不响应的设备就能把一次「搜音响」拖到一百秒。预算 = 剩余时间，夹在
     * [`PER_DEVICE_FETCH_BUDGET_MS`] 与 [`MAX_FETCH_BUDGET_MS`] 之间。
     */
    fun fetchBudgetMs(timeoutMs: Int, elapsedMs: Long): Long {
        val remaining = timeoutMs - elapsedMs
        // 抓包本身可能已经用光预算：仍然给一点时间，否则搜到的设备一台都读不出来。
        val floor = PER_DEVICE_FETCH_BUDGET_MS.toLong()
        return remaining.coerceIn(floor, MAX_FETCH_BUDGET_MS.toLong())
    }

    /** 回取并发：设备少就少开线程，别为两台设备起一个池。 */
    fun fetchConcurrency(devices: Int): Int = devices.coerceIn(1, MAX_FETCH_CONCURRENCY)

    /** M-SEARCH 的报文。`MX` 与 [WINDOW_MS] 同源，改一个另一个跟着变。 */
    fun searchRequest(searchTarget: String, host: String, port: Int): ByteArray = (
        "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: $host:$port\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: $MX_SECONDS\r\n" +
            "ST: $searchTarget\r\n" +
            "\r\n"
        ).toByteArray(Charsets.UTF_8)

    /** SSDP 应答的收缓冲大小：2048 字节装不下某些设备的长 USN + 多个头，会被截断成畸形应答。 */
    const val RECEIVE_BUFFER_BYTES = 8192
}
