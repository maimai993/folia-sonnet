Folia Linux 便携版说明
======================

此压缩包包含以下内容：

- `folia-major`：程序可执行文件
- `resources/linux/icon.png`：应用图标
- `resources/linux/folia-major.desktop`：桌面启动项模板

如何创建桌面启动项：

1. 将桌面模板复制到：
   `~/.local/share/applications/folia-major.desktop`

2. 修改复制后的文件，将以下占位符替换为实际路径：
   `__APP_PATH__`  -> `folia-major` 可执行文件的绝对路径
   `__ICON_PATH__` -> `resources/linux/icon.png` 的绝对路径

示例：
`Exec=/home/yourname/Apps/Folia/folia-major`
`Icon=/home/yourname/Apps/Folia/resources/linux/icon.png`

3. 如果您的桌面环境有要求，请将该 `.desktop` 文件标记为可信或可执行。
