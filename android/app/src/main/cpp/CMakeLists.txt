# 当前文件：Folia 安卓端原生构建配置。
#
# 这里编出 libfolia-node-native.so（Java 侧 System.loadLibrary("folia-node-native")）。
#
# Node 本身是预编译的：nodejs-mobile 18.20.4 的 libnode.so（arm64-v8a）放在
# cpp/libnode/<ABI>/ 下，作为 IMPORTED 库链接进来 —— 它的头文件在 cpp/include/node/。
#
# 为什么用 IMPORTED 而不是 jniLibs：libnode.so 不参与编译，只参与链接与打包，
# 放在 cpp 下面可以让「Node 运行时」这一块的东西都待在一个目录里。

cmake_minimum_required(VERSION 3.22.1)
project(folia_node_native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libnode.so：nodejs-mobile 的预编译 Node。
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/libnode/${ANDROID_ABI}/libnode.so)

# Node 的头文件（node.h / uv.h 等）。
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include/node)

add_library(folia-node-native SHARED
    folia-node-native.cpp
    folia-node-bridge.cpp)

find_library(log-lib2 log)

target_link_libraries(folia-node-native
    node
    ${log-lib2})

# 16KB 页对齐（Android 15+ / 新设备要求）。
target_link_options(folia-node-native PRIVATE "-Wl,-z,max-page-size=16384")
