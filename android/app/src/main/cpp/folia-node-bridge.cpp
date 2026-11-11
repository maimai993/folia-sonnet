// 当前文件：Folia 安卓端 Node 运行时的原生模块（通道实现）。
//
// 与 Mineradio 那套 rn-bridge 同一做法：注册一个**链接模块**（NODE_MODULE_LINKED），
// Node 侧用 `process._linkedBinding('folia_node_bridge')` 拿到它（require 也可以，
// nodejs-mobile 给 require 加过钩子；两者都试一遍最稳）。
//
// 暴露三个方法：
//   · registerChannel(name, fn) —— 订阅一个通道，Java 那边发来的消息进这个函数；
//   · emit(channel, payload)    —— 往 Java 发消息；
//   · getDataDir()              —— 模组的 userData 目录。
//
// 消息队列用 uv_async：Java 那边随时可能发消息过来，而 V8 的调用只能在 Node 自己的线程上做，
// 所以先入队，再用 uv_async 把 Node 线程唤醒后逐条调用。
// uv_async 句柄必须在 Node 线程上创建 —— 所以在注册通道时创建（那一刻就在 Node 线程上）。

#include "folia-node-bridge.h"

#include <node.h>
#include <uv.h>

#include <cstdio>
#include <map>
#include <mutex>
#include <queue>
#include <string>

namespace {

FoliaNodeMessageCallback g_on_message = nullptr;
FoliaNodeReadyCallback g_on_ready = nullptr;
FoliaNodeFailureCallback g_on_failure = nullptr;
std::string g_data_dir;

class Channel;

std::mutex g_channels_mutex;
std::map<std::string, Channel*> g_channels;

std::mutex g_queue_mutex;
std::queue<std::pair<std::string, std::string>> g_queue;
uv_async_t* g_queue_handle = nullptr;

void flush_queue(uv_async_t* handle);

class Channel {
public:
    explicit Channel(const std::string& name) : name_(name) {}

    // 在 Node 线程上调用：装上订阅函数，并建好 uv_async 句柄。
    void set_function(v8::Isolate* isolate, v8::Local<v8::Function> fn) {
        isolate_ = isolate;
        function_.Reset(isolate, fn);
        if (queue_handle_ == nullptr) {
            queue_handle_ = static_cast<uv_async_t*>(malloc(sizeof(uv_async_t)));
            if (queue_handle_ != nullptr) {
                uv_async_init(uv_default_loop(), queue_handle_, flush_queue);
                queue_handle_->data = this;
            }
        }
    }

    bool has_function() const { return !function_.IsEmpty(); }
    v8::Isolate* isolate() const { return isolate_; }
    v8::Persistent<v8::Function>& function() { return function_; }
    const std::string& name() const { return name_; }

    uv_async_t* queue_handle() const { return queue_handle_; }

private:
    std::string name_;
    v8::Isolate* isolate_ = nullptr;
    v8::Persistent<v8::Function> function_;
    uv_async_t* queue_handle_ = nullptr;
};

// 在 Node 线程上把一条消息交给通道的订阅函数。
void deliver(Channel* channel, const std::string& payload) {
    if (channel == nullptr || !channel->has_function()) return;
    v8::Isolate* isolate = channel->isolate();
    if (isolate == nullptr) return;
    v8::HandleScope scope(isolate);
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    if (context.IsEmpty()) return;
    v8::Local<v8::Function> fn = v8::Local<v8::Function>::New(isolate, channel->function());
    /*
     * 实参顺序：(channelName, payload)。
     *
     * 两个字符串都先落到具名 Local 再放进数组。原来是把两次 NewFromUtf8 直接写在
     * 数组初始化列表里，第一个用的是 channel->name().c_str() —— 临时 std::string，
     * 语句结束即析构；第二次分配很可能复用同一块堆内存，于是 JS 侧收到的 payload
     * 变成了通道名本身（实测：Node 收到 "host"，JSON.parse 必然失败）。具名中间变量
     * 让两个 v8 字符串先各自拷贝完，再进数组。
     */
    std::string channel_name = channel->name();
    v8::Local<v8::String> argChannel = v8::String::NewFromUtf8(isolate, channel_name.c_str()).ToLocalChecked();
    v8::Local<v8::String> argPayload = v8::String::NewFromUtf8(isolate, payload.c_str()).ToLocalChecked();
    /*
     * 只传一个实参：payload。
     *
     * 这里原来是 argc=2、数组里放 {通道名, payload}，但 nodejs-mobile 预编译的 V8 里
     * Function::Call 的这个重载在精简头文件下被解析成了别的签名，实测 JS 侧拿到的
     * arguments.length 是 5，而且第 0 个就是通道名 "host" —— JSON.parse 必然失败，
     * 所有宿主请求都变成「收到无法解析的宿主请求」。
     * 通道名对订阅者没有用处（订阅本身就是按通道注册的），所以只送 payload，
     * 顺便把 argc 固定成 1，绕开这个重载的不确定性。
     */
    v8::Local<v8::Value> args[1] = { argPayload };
    v8::TryCatch try_catch(isolate);
    fn->Call(context, context->Global(), 1, args).IsEmpty();
    // nodejs-mobile 精简过的 V8 头部里没有 GetCurrentException / ReportPendingException，
    // 所以用一个局部 TryCatch：它自己会待住异常，析构时不会把异常漏给 uv 回调。
    // 不往外抛是有意的 —— 回调里的一句坏日志不该弄死整个 Node 线程。
    if (try_catch.HasCaught()) {
        v8::String::Utf8Value text(isolate, try_catch.Exception());
        if (*text != nullptr) fprintf(stderr, "[folia-node] 通道 %s 回调抛了：%s\n", channel->name().c_str(), *text);
        try_catch.Reset();
    }
}

void flush_queue(uv_async_t* handle) {
    std::queue<std::pair<std::string, std::string>> pending;
    {
        std::lock_guard<std::mutex> lock(g_queue_mutex);
        pending.swap(g_queue);
    }
    while (!pending.empty()) {
        auto item = pending.front();
        pending.pop();
        Channel* channel = nullptr;
        {
            std::lock_guard<std::mutex> lock(g_channels_mutex);
            auto it = g_channels.find(item.first);
            if (it != g_channels.end()) channel = it->second;
        }
        deliver(channel, item.second);
    }
    (void)handle;
}

void method_register_channel(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    if (args.Length() < 2 || !args[0]->IsString() || !args[1]->IsFunction()) {
        isolate->ThrowException(v8::Exception::TypeError(
                v8::String::NewFromUtf8(isolate, "registerChannel(name, fn)").ToLocalChecked()));
        return;
    }
    v8::String::Utf8Value name(isolate, args[0]);
    std::string channel_name(*name ? *name : "");
    Channel* channel = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_channels_mutex);
        auto it = g_channels.find(channel_name);
        if (it == g_channels.end()) {
            channel = new Channel(channel_name);
            g_channels[channel_name] = channel;
        } else {
            channel = it->second;
        }
    }
    channel->set_function(isolate, v8::Local<v8::Function>::Cast(args[1]));
    // 第一个建好句柄的通道当全局唤醒句柄：Java 在 Node 还没注册任何通道时发来的
    // 消息，就靠它把 Node 线程叫醒。
    if (g_queue_handle == nullptr) g_queue_handle = channel->queue_handle();
}

void method_emit(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    if (args.Length() < 2 || !args[0]->IsString()) return;
    v8::String::Utf8Value channel(isolate, args[0]);
    v8::String::Utf8Value payload(isolate, args[1]);
    if (g_on_message != nullptr) {
        g_on_message(*channel ? *channel : "", *payload ? *payload : "");
    }
}

void method_ready(const v8::FunctionCallbackInfo<v8::Value>& args) {
    (void)args;
    if (g_on_ready != nullptr) g_on_ready();
}

void method_failure(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::String::Utf8Value reason(isolate, args[0]);
    if (g_on_failure != nullptr) g_on_failure(*reason ? *reason : "unknown");
}

void method_get_data_dir(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    args.GetReturnValue().Set(
            v8::String::NewFromUtf8(isolate, g_data_dir.c_str()).ToLocalChecked());
}

void init(v8::Local<v8::Object> exports) {
    NODE_SET_METHOD(exports, "registerChannel", method_register_channel);
    NODE_SET_METHOD(exports, "emit", method_emit);
    NODE_SET_METHOD(exports, "ready", method_ready);
    NODE_SET_METHOD(exports, "failure", method_failure);
    NODE_SET_METHOD(exports, "getDataDir", method_get_data_dir);
}

}  // namespace

void folia_node_set_callbacks(FoliaNodeMessageCallback on_message,
                              FoliaNodeReadyCallback on_ready,
                              FoliaNodeFailureCallback on_failure) {
    g_on_message = on_message;
    g_on_ready = on_ready;
    g_on_failure = on_failure;
}

void folia_node_set_data_dir(const char* path) {
    g_data_dir = path ? path : "";
}

void folia_node_send_to_node(const char* channel, const char* payload) {
    {
        std::lock_guard<std::mutex> lock(g_queue_mutex);
        g_queue.emplace(channel ? channel : "", payload ? payload : "");
    }
    // uv_async_send 是线程安全的：Java 线程可以直接调。
    // 句柄可能还没建（Node 还没跑到注册通道那一步）——那种情况下消息留在队列里，
    // 等 uv_async 建好时补发一次。
    Channel* target = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_channels_mutex);
        auto it = g_channels.find(channel ? channel : "");
        if (it != g_channels.end()) target = it->second;
    }
    if (target != nullptr && target->queue_handle() != nullptr) {
        uv_async_send(target->queue_handle());
    } else if (g_queue_handle != nullptr) {
        uv_async_send(g_queue_handle);
    }
}

const char* folia_node_data_dir() {
    return g_data_dir.c_str();
}

NODE_MODULE_LINKED(folia_node_bridge, init);
