package top.izuna.foliamajor;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地音频流服务器。
 *
 * 两种来源：
 *   /audio/<MediaStore id>          系统媒体库里的文件
 *   /audio/imported-<file name>     通过系统文件管理器挑选后复制进 App 私有目录的文件
 *
 * WebView 的 <audio> 播不了 content:// 这种 URI，也不认 App 私有目录里的路径，
 * 所以原生起一个只监听 127.0.0.1 的小服务，把音频以 http 的形式喂回去。
 * 必须支持 Range：<audio> 拖进度、以及某些格式要先读文件尾部的元数据，都靠它。
 */
final class LocalAudioServer {
    private static final String TAG = "LocalAudioServer";
    private static final String AUDIO_PATH_PREFIX = "/audio/";
    private static final String IMPORTED_PREFIX = "imported-";
    /** 直接按绝对路径流原文件的 ref 前缀（文件系统兜底扫描出来的歌，不复制进私有目录）。 */
    private static final String FILE_PREFIX = "file-";
    private final Context context;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private ServerSocket serverSocket;
    private int port;

    LocalAudioServer(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized int start() throws IOException {
        if (serverSocket != null && !serverSocket.isClosed()) return port;
        // 端口交给系统分配（0）：写死一个的话，被别的进程占了就起不来，
        // 而每次启动拿到的端口都可能不同，所以 URL 不能持久化，播放前要重新拼（见插件的 localAudioServerPort）。
        serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        port = serverSocket.getLocalPort();
        executor.execute(() -> {
            while (!serverSocket.isClosed()) {
                try {
                    Socket socket = serverSocket.accept();
                    executor.execute(() -> handle(socket));
                } catch (IOException ignored) {
                    Log.i(TAG, "server socket closed, stopping accept loop");
                    break;
                }
            }
        });
        return port;
    }

    int getPort() {
        return port;
    }

    /** 复制进私有目录的音频存放位置。 */
    File importedAudioDirectory() {
        File dir = new File(context.getFilesDir(), "imported-audio");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void handle(Socket socket) {
        try (Socket client = socket;
             BufferedInputStream input = new BufferedInputStream(client.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(client.getOutputStream())) {
            String requestLine = readLine(input);
            if (requestLine == null) return;
            String[] requestParts = requestLine.split(" ");
            if (requestParts.length < 2) return;

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                int separator = line.indexOf(':');
                if (separator > 0) {
                    headers.put(
                        line.substring(0, separator).trim().toLowerCase(),
                        line.substring(separator + 1).trim()
                    );
                }
            }

            String path = requestParts[1];
            int query = path.indexOf('?');
            if (query >= 0) path = path.substring(0, query);
            if (!path.startsWith(AUDIO_PATH_PREFIX)) {
                writeStatus(output, 404, "Not Found");
                return;
            }

            String token = URLDecoder.decode(path.substring(AUDIO_PATH_PREFIX.length()), "UTF-8");
            if (token.startsWith(IMPORTED_PREFIX)) {
                streamImportedFile(output, requestParts, headers, token.substring(IMPORTED_PREFIX.length()));
                return;
            }
            if (token.startsWith(FILE_PREFIX)) {
                streamExternalFile(output, requestParts, headers, token.substring(FILE_PREFIX.length()));
                return;
            }
            streamMediaStoreFile(output, requestParts, headers, token);
        } catch (Exception error) {
            // 之前这里连日志都没有：流写到一半断掉，WebView 那边只会报一句
            // Format error，原生侧连发生了什么都不知道。
            Log.w(TAG, "audio request failed", error);
        }
    }

    private void streamMediaStoreFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String mediaId
    ) throws IOException {
        Uri uri = Uri.withAppendedPath(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId);
        ContentResolver resolver = context.getContentResolver();
        long size = -1;
        String mime = "audio/*";
        try (Cursor cursor = resolver.query(uri, new String[]{
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE
        }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                size = cursor.getLong(0);
                String queriedMime = cursor.getString(1);
                if (queriedMime != null && !queriedMime.isEmpty()) mime = queriedMime;
            }
        }
        writeResponse(output, requestParts, headers, size, mime, () -> resolver.openInputStream(uri));
    }

    private void streamImportedFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String fileName
    ) throws IOException {
        File target = new File(importedAudioDirectory(), fileName);
        if (!target.isFile()) {
            Log.w(TAG, "imported audio missing: " + fileName);
            writeStatus(output, 404, "Not Found");
            return;
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(fileName),
            () -> new FileInputStream(target)
        );
    }

    /**
     * 按绝对路径流用户自己的音频（文件系统兜底扫描的歌）。
     *
     * 只放行外存根目录下的音频文件，别的一律 404 —— 这个服务监听在 127.0.0.1 上，
     * 设备上任何应用都能连上来，不能让它变成一个任读全盘的口子。
     * 走这条路的歌要求已授予「所有文件访问」，没授权时读流会自己失败。
     */
    private void streamExternalFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String encodedPath
    ) throws IOException {
        String filePath = URLDecoder.decode(encodedPath, "UTF-8");
        File target = new File(filePath);
        File root = Environment.getExternalStorageDirectory();
        boolean insideRoot = root != null && filePath.startsWith(root.getPath() + File.separator);
        if (!insideRoot || !target.isFile() || !isAudioFileName(filePath)) {
            Log.w(TAG, "external audio refused: " + filePath);
            writeStatus(output, 404, "Not Found");
            return;
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(filePath),
            () -> new FileInputStream(target)
        );
    }

    private interface StreamSupplier {
        InputStream open() throws IOException;
    }

    private void writeResponse(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        long size,
        String mime,
        StreamSupplier supplier
    ) throws IOException {
        // 空文件喂给 <audio> 只会换来一句莫名的 MEDIA_ELEMENT_ERROR: Format error；
        // 这里直接 404 并把原因写进日志，下次一眼就能看出是"文件是空的"。
        if (size <= 0) {
            Log.w(TAG, "audio source is empty or unreadable (size=" + size + "): " + requestParts[1]);
            writeStatus(output, 404, "Empty Audio");
            return;
        }
        long start = 0;
        long end = size > 0 ? size - 1 : -1;
        String range = headers.get("range");
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String[] parts = range.substring(6).split("-", -1);
            try {
                if (!parts[0].isEmpty()) start = Long.parseLong(parts[0]);
                if (parts.length > 1 && !parts[1].isEmpty()) end = Long.parseLong(parts[1]);
                if (size > 0) end = Math.min(end, size - 1);
                partial = true;
            } catch (NumberFormatException ignored) {
                start = 0;
                end = size > 0 ? size - 1 : -1;
                partial = false;
            }
        }

        long contentLength = end >= start ? end - start + 1 : -1;
        Log.i(TAG, requestParts[0] + " " + requestParts[1]
            + " range=" + (range == null ? "-" : range)
            + " size=" + size + " partial=" + partial
            + (partial ? " bytes=" + start + "-" + end : ""));
        StringBuilder response = new StringBuilder();
        response.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        response.append("Content-Type: ").append(mime).append("\r\n");
        response.append("Accept-Ranges: bytes\r\n");
        response.append("Access-Control-Allow-Origin: *\r\n");
        // crossOrigin="anonymous" 的 <audio> 会带 CORS 语义，把 Range 相关头暴露出来，
        // 拖进度条（发 Range、读 Content-Range）才不会在 CORS 检查上被拦。
        response.append("Access-Control-Allow-Headers: range, content-range, content-length\r\n");
        response.append("Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n");
        response.append("Connection: close\r\n");
        if (size > 0) {
            response.append("Content-Length: ").append(contentLength).append("\r\n");
            if (partial) {
                response.append("Content-Range: bytes ")
                    .append(start).append('-').append(end).append('/').append(size).append("\r\n");
            }
        }
        response.append("\r\n");
        output.write(response.toString().getBytes(StandardCharsets.US_ASCII));

        // HEAD 只回头部：<audio> 在真正下载前会先探一次，那时不能把整首歌读一遍。
        if ("GET".equals(requestParts[0])) {
            try (InputStream audio = supplier.open()) {
                if (audio != null) {
                    skipFully(audio, start);
                    byte[] buffer = new byte[64 * 1024];
                    long remaining = contentLength;
                    int read;
                    while ((read = audio.read(buffer)) != -1 && (remaining < 0 || remaining > 0)) {
                        int writeLength = remaining < 0 ? read : (int) Math.min(read, remaining);
                        output.write(buffer, 0, writeLength);
                        if (remaining > 0) remaining -= writeLength;
                    }
                }
            }
        }
        output.flush();
    }

    /**
     * InputStream.skip 不保证一次跳够（它爱跳多少跳多少），文件流上偶尔也会短跳。
     * 之前直接一个 skip 了事，短跳时从错误的位置开始发 —— 解码器读到的就是一段
     * 被错位的数据，表现正是「MEDIA_ELEMENT_ERROR: Format error」这类莫名失败。
     */
    private static void skipFully(InputStream audio, long bytes) throws IOException {
        long remaining = bytes;
        while (remaining > 0) {
            long skipped = audio.skip(remaining);
            if (skipped <= 0) {
                // skip 返回 0 只能靠读来推进（可能已经到头）。
                if (audio.read() == -1) return;
                skipped = 1;
            }
            remaining -= skipped;
        }
    }

    /** 路径是不是设备上常见的音频扩展名（文件系统兜底扫描与 file- 路由共用）。 */
    static boolean isAudioFileName(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
            || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
            || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma");
    }

    static String guessMimeType(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        if (lower.endsWith(".opus")) return "audio/opus";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".ape")) return "audio/ape";
        if (lower.endsWith(".wma")) return "audio/x-ms-wma";
        return "audio/mpeg";
    }

    private static String readLine(InputStream input) throws IOException {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') line.append((char) value);
        }
        return value == -1 && line.length() == 0 ? null : line.toString();
    }

    private static void writeStatus(OutputStream output, int status, String message) throws IOException {
        String response = "HTTP/1.1 " + status + " " + message + "\r\n"
            + "Content-Length: 0\r\nConnection: close\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }
}
