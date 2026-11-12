// 当前文件：Folia 安卓端 Node 运行时的 JNI 桥（native 层）。
//
// 职责：
//   · 加载 nodejs-mobile 的 libnode.so，起 Node 线程并跑宿主脚本；
//   · 提供一条 Java↔Node 的消息通道（Java 发过去的进 Node 的队列，Node 发回来的回调 Java）；
//   · 把 libnode.so 需要的参数（HOME / NODE_PATH / TMPDIR）摆好。
//
// 与 Mineradio 那套 rn-bridge 的差别：那套的通道名固定成几个，这里是通用的字符串通道 + 一个
// 统一的出站回调，模组宿主只需要认自己的通道名。

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>

#include "node.h"
#include "uv.h"
#include "folia-node-bridge.h"

#define LOG_TAG "FoliaNodeNative"

namespace {

// Java 侧 FoliaNodeRuntime 的静态方法缓存。
jclass g_runtimeClass = nullptr;
jmethodID g_notifyReady = nullptr;
jmethodID g_notifyFailure = nullptr;
jmethodID g_dispatchFromNode = nullptr;

JavaVM* g_vm = nullptr;

// Node 发给 Java 的出站回调（Node 线程上调用）。
void on_node_message(const char* channel, const char* payload) {
    if (!g_vm || !g_runtimeClass) return;
    JNIEnv* env = nullptr;
    bool attached = false;
    // Node 的线程不是 JVM 线程：需要时自己 attach。
    if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    jstring jchannel = env->NewStringUTF(channel ? channel : "");
    jstring jpayload = env->NewStringUTF(payload ? payload : "");
    env->CallStaticVoidMethod(g_runtimeClass, g_dispatchFromNode, jchannel, jpayload);
    env->DeleteLocalRef(jchannel);
    env->DeleteLocalRef(jpayload);
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
}

// Node 宿主脚本加载完时调回 Java。
void on_node_ready() {
    if (!g_vm || !g_runtimeClass) return;
    JNIEnv* env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    env->CallStaticVoidMethod(g_runtimeClass, g_notifyReady);
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
}

void on_node_failure(const char* reason) {
    if (!g_vm || !g_runtimeClass) return;
    JNIEnv* env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    jstring jreason = env->NewStringUTF(reason ? reason : "unknown");
    env->CallStaticVoidMethod(g_runtimeClass, g_notifyFailure, jreason);
    env->DeleteLocalRef(jreason);
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
}

// stdout/stderr 重定向到 logcat：Node 的 console.log 走这里。
int g_stdoutPipe[2];
int g_stderrPipe[2];

void* thread_stdout(void*) {
    char buffer[2048];
    ssize_t n;
    while ((n = read(g_stdoutPipe[0], buffer, sizeof(buffer) - 1)) > 0) {
        buffer[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buffer);
    }
    return nullptr;
}

void* thread_stderr(void*) {
    char buffer[2048];
    ssize_t n;
    while ((n = read(g_stderrPipe[0], buffer, sizeof(buffer) - 1)) > 0) {
        buffer[n] = 0;
        __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, buffer);
    }
    return nullptr;
}

void redirect_stdout_stderr() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (pipe(g_stdoutPipe) == 0) {
        dup2(g_stdoutPipe[1], STDOUT_FILENO);
        pthread_t thread;
        if (pthread_create(&thread, nullptr, thread_stdout, nullptr) == 0) pthread_detach(thread);
    }
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(g_stderrPipe) == 0) {
        dup2(g_stderrPipe[1], STDERR_FILENO);
        pthread_t thread;
        if (pthread_create(&thread, nullptr, thread_stderr, nullptr) == 0) pthread_detach(thread);
    }
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {
    (void)reserved;
    g_vm = vm;
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    g_runtimeClass = env->FindClass("top/izuna/foliamajor/mods/FoliaNodeRuntime");
    if (g_runtimeClass == nullptr) return JNI_ERR;
    g_runtimeClass = (jclass)env->NewGlobalRef(g_runtimeClass);
    g_notifyReady = env->GetStaticMethodID(g_runtimeClass, "notifyReady", "()V");
    g_notifyFailure = env->GetStaticMethodID(g_runtimeClass, "notifyFailure", "(Ljava/lang/String;)V");
    g_dispatchFromNode = env->GetStaticMethodID(
            g_runtimeClass, "dispatchFromNode", "(Ljava/lang/String;Ljava/lang/String;)V");
    if (!g_notifyReady || !g_notifyFailure || !g_dispatchFromNode) return JNI_ERR;
    return JNI_VERSION_1_6;
}

// 起 Node：参数是宿主脚本路径、home 目录、userData 目录、临时目录。
JNIEXPORT void JNICALL
Java_top_izuna_foliamajor_mods_FoliaNodeRuntime_nativeStart(
        JNIEnv* env, jclass, jstring entryPath, jstring homeDir, jstring userDataDir, jstring cacheDir) {
    const char* entry = env->GetStringUTFChars(entryPath, nullptr);
    const char* home = env->GetStringUTFChars(homeDir, nullptr);
    const char* userData = env->GetStringUTFChars(userDataDir, nullptr);
    const char* tmp = env->GetStringUTFChars(cacheDir, nullptr);

    // Android 上这些环境变量决定 Node 去哪儿找家目录、临时文件和内置模块。
    setenv("HOME", home, 1);
    setenv("TMPDIR", tmp, 1);
    setenv("TMP", tmp, 1);
    setenv("TEMP", tmp, 1);
    setenv("NODE_PATH", userData, 1);
    // Node 18 默认用 OpenSSL 3；nodejs-mobile 带的 OpenSSL 1.1 走这个开关。
    setenv("OPENSSL_CONF", "", 1);

    folia_node_set_data_dir(userData);
    folia_node_set_callbacks(on_node_message, on_node_ready, on_node_failure);

    redirect_stdout_stderr();

    const char* argv[] = {"node", entry, nullptr};
    int status = node::Start(2, const_cast<char**>(argv));

    env->ReleaseStringUTFChars(entryPath, entry);
    env->ReleaseStringUTFChars(homeDir, home);
    env->ReleaseStringUTFChars(userDataDir, userData);
    env->ReleaseStringUTFChars(cacheDir, tmp);

    if (status != 0) {
        on_node_failure("Node 退出，状态码非 0");
    }
}

// Java → Node：把一条消息送进 Node 侧注册的通道。
JNIEXPORT void JNICALL
Java_top_izuna_foliamajor_mods_FoliaNodeRuntime_nativeSendToNode(
        JNIEnv* env, jclass, jstring channel, jstring payload) {
    const char* channelName = env->GetStringUTFChars(channel, nullptr);
    const char* text = env->GetStringUTFChars(payload, nullptr);
    __android_log_print(ANDROID_LOG_INFO, "FoliaNodeNative",
                        "nativeSendToNode channel=[%s] payloadLen=%zu",
                        channelName ? channelName : "(null)",
                        text ? strlen(text) : (size_t)0);
    folia_node_send_to_node(channelName, text);
    env->ReleaseStringUTFChars(channel, channelName);
    env->ReleaseStringUTFChars(payload, text);
}

// Node 侧要拿数据目录时问这里（与 rn-bridge 的 getDataDir 同一用途）。
JNIEXPORT jstring JNICALL
Java_top_izuna_foliamajor_mods_FoliaNodeRuntime_nativeGetDataDir(JNIEnv* env, jclass) {
    const char* dir = folia_node_data_dir();
    return env->NewStringUTF(dir ? dir : "");
}

}  // extern "C"
