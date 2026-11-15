// 当前文件：Folia 安卓端 Node 运行时的原生模块（通道实现）。
//
// Node 与 Java 之间只有一条消息通道，两边都能用：
//   · Java → Node：`foliaNode.sendMessage(channel, payload)`，进 Node 侧注册的通道。
//   · Node → Java：`foliaNode.emit(channel, payload)`，由 native 层回调 Java。
//
// 通道名是字符串，宿主脚本自己认（见 assets/folia-node/host.js）。

#ifndef FOLIA_NODE_BRIDGE_H
#define FOLIA_NODE_BRIDGE_H

#include <string>

// Node → Java 的出站回调。
typedef void (*FoliaNodeMessageCallback)(const char* channel, const char* payload);
typedef void (*FoliaNodeReadyCallback)();
typedef void (*FoliaNodeFailureCallback)(const char* reason);

// 装上回调与数据目录。必须在 node::Start 之前调用。
void folia_node_set_callbacks(FoliaNodeMessageCallback on_message,
                              FoliaNodeReadyCallback on_ready,
                              FoliaNodeFailureCallback on_failure);
void folia_node_set_data_dir(const char* path);

// Java → Node：把一条消息送进 Node 侧注册过的通道。
void folia_node_send_to_node(const char* channel, const char* payload);

// Node 侧要问数据目录时用（Node 的宿主脚本里有同一个值，这里是原生的一份）。
const char* folia_node_data_dir();

#endif  // FOLIA_NODE_BRIDGE_H
