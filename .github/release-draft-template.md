## 下载说明

- Windows：下载 `Folia-Setup-<version>.exe`
- macOS：
  - Apple Silicon：下载 `Folia-<version>-arm64.dmg`
  - Intel Mac：下载 `Folia-<version>-x64.dmg`
  - 如果打开时提示“应用已损坏”，这通常是当前 macOS 包未签名 / 未 notarize 导致的 Gatekeeper 拦截，不是安装包本身损坏。解决方法见[这份说明]({{MACOS_UNSIGNED_HELP_URL}})
- Linux：
  - Arch Linux / Manjaro：通过 AUR 安装 `yay -S folia-major-bin`
  - Debian / Ubuntu：下载 `folia-major-<version>-linux-amd64.deb`
  - Fedora / openSUSE：下载 `folia-major-<version>-linux-x86_64.rpm`
  - 其他发行版：下载 `folia-major-<version>-linux-x64.tar.gz`

## 更新说明

- 待补充本次版本的主要变更

## Realeco 发布流程

- 正式发布由根目录 `realeco-release` 触发；该文件、`package.json` 和完整提交信息 `release: vA.B.C` 必须使用相同版本。
- 工作流只创建或更新草稿 Release；确认后请在 GitHub 手动公开，客户端才会收到更新。

_语言的产生，并不能增加或减轻人类沉默的痛苦，而历史无声地活在英雄们的心中_
