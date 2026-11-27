# NAS 架构与 Windows 导出

Windows 服务端启动器的 NAS 部署页可以选择 **x86-64 AMD64** 或 **ARM64**。这是 NAS 的处理器架构，与运行启动器的 Windows 电脑架构无关。ARM64 通常也标为 aarch64；32 位 ARM 不在本次支持范围。

## 当前提供的内容

| NAS 架构 | 当前导出方式 | 安装条件 |
| --- | --- | --- |
| x86-64 AMD64 | 已有验收通过的离线镜像包 | 导入 image.tar 后启动 Compose |
| ARM64 | 已有验收通过的离线镜像包 | 导入 image.tar 后启动 Compose |

ARM64 镜像已于 2026-11-27 在 GitHub 的原生 ARM64 执行机完成真实构建与容器验收：[构建记录](https://github.com/Xueluoa1/yingjian/actions/runs/45918385880)。检查涵盖非 root 启动、健康状态、管理登录、静态资源、设备配对和容器重建后的数据保留。新版完整 Windows 包内置 AMD64 和 ARM64 两份镜像，均可离线导出。本地 Windows 未运行 Docker，ARM64 实际运行验证发生在云端。

独立 ARM64 成品包为 `Yingjian-Server-0.1.4-nas1-linux-arm64-Offline.zip`。名称含 `Source` 的包是维护者备用源码，不是离线镜像。32 位 ARM / ARMv7 不适用。

## 在 Windows 启动器中导出

1. 打开完整包内的 Yingjian-Server.exe，切换到 NAS 部署。
2. 按 NAS 处理器选择 AMD64 或 ARM64。页面会显示该架构当前是离线镜像还是源码构建模式。
3. 填写 NAS 局域网地址、端口和管理密码。已有服务填写原数据卷的准确名称。
4. 导出后上传整个文件夹。离线包先导入 image.tar；源码包按说明执行构建。两者的 .env 均已由启动器生成。

带架构的源码包同时包含固定 platform 的 Compose 和 target-platform.txt。脚本会在修改容器或配置之前拒绝错误架构；通过 NAS 图形界面部署时也必须选择匹配的包。升级继续使用原项目、.env 和数据卷，不删除旧卷。

## 后续更新：没有 Docker 机器时制作离线包

仓库新增 GitHub Actions 工作流 `.github/workflows/nas-offline.yml`，使用对应架构的 Linux 执行机进行真实容器验收。它支持手动运行；推送到 `codex/nas-arm64-build-*` 专用构建分支时也会自动制作 ARM64。它只生成构建产物，不部署 NAS，也不发布镜像到公共仓库。

1. 将当前干净源码和工作流更新到自己的 GitHub 仓库。手动运行入口要求工作流已存在于默认分支；也可使用上述专用构建分支触发。不要上传家庭 data、实际 .env 或测试结果。
2. 在仓库 Actions 中打开 **Build verified NAS offline image**，点击 Run workflow，选择 arm64。
3. 全部检查成功后，下载本次运行的 `Yingjian-NAS-linux-arm64-Offline` 产物。外层是 GitHub 下载归档，内部包含离线部署 ZIP 和 SHA256 文件。
4. 解压内部的部署 ZIP。它应包含 image.tar、verification.json、manifest.json 等 10 个文件。只有实际构建和验收成功时才会生成该产物。

该流程依赖 GitHub Actions 的可用执行机、仓库权限和账户额度，本地检查不能替代实际运行。执行机说明见 [GitHub 官方文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

## 接入已验证的 ARM64 镜像

将已解压的 ARM64 离线包中的 10 个文件放入 Windows 完整包的 `deployment/nas-offline/arm64/`。不要放置额外 .env。重新打开启动器选择 ARM64，即可切换为校验并导出离线包；校验不通过会拒绝导出。AMD64 包保存在同级 `amd64/`，旧版平铺目录仍兼容 AMD64。

开发打包也可同时传入两份已验收的包：

```powershell
.\scripts\package-server.ps1 -DestinationRoot .\release\new-build -NasOfflineBundle <AMD64完整目录> -NasArm64OfflineBundle <ARM64完整目录>
```

本地 Linux Docker 构建命令：

```sh
sh scripts/build-nas-image.sh /path/to/output arm64
```

它会按目标架构构建，并实际检查非 root 启动、管理登录、静态资源、设备配对和重建后的数据持久化；任何一步失败都不会发布离线包。无需访问家庭服务。AMD64 上制作 ARM64 需要预先配置相应模拟能力；脚本不会自动修改主机的模拟器设置。原生 ARM64 构建优先。
