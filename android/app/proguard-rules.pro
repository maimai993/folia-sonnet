# R8 规则。release 开了 minifyEnabled + shrinkResources，这里每一条都是「不加就会静默失效」的地方。
#
# 判断标准：只要某段代码是靠「名字」在运行时被找到的（反射、注解、字符串），就必须 keep。
# 靠类型直接调用的，一律不 keep —— 那是 R8 该裁的部分。

# ---------------------------------------------------------------- Capacitor 桥

# 插件类本身：Capacitor 按 @CapacitorPlugin 的名字把它登记进 JS 调用表，
# 混淆类名会让 JS 侧报 "not implemented"。成员一并保留，插件彼此之间会直调。
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }

# @PluginMethod / @PermissionCallback / @ActivityCallback 都是按方法名反射调用。
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}

# 桥内部大量用 Bundle -> JSON 的反射字段读取，整体保留。
# 这一块约几百 KB，是开 R8 之后仍然留在包里的大头；精确裁剪的收益抵不上一次白屏。
-keep class com.getcapacitor.** { *; }

# WebView 注入给 JS 的对象。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ---------------------------------------------------------------- 第三方

# Lyricon：状态栏歌词 SDK，Kotlin data class 靠字段名序列化。
-keep class io.github.proify.lyricon.** { *; }
-dontwarn io.github.proify.lyricon.**

# media3 / ExoPlayer 自带 consumer rules，只关掉可选依赖缺失的警告。
-dontwarn androidx.media3.**

# OkHttp 自带 consumer rules（含 okio），这里不重复声明。

# ---------------------------------------------------------------- 语言与平台

# Kotlin 反射元数据。
-keep class kotlin.Metadata { *; }
-keepclassmembers class **$WhenMappings { <fields>; }

# 枚举的 values()/valueOf() 由运行时反射调用。
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Parcelable 的 CREATOR 按字段名查找。
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}

# 泛型签名：Gson/JSON 之外，Kotlin 的 suspend 与集合类型也依赖它。
-keepattributes Signature,InnerClasses,EnclosingMethod

# 崩溃栈要能看出是哪个文件哪一行。混淆名已经够用，行号必须留。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
