# 开发与构建

## 环境

- 服务端：Node.js 22+，建议 Node.js 24；通过 `npm ci` 安装锁定依赖。
- Windows 启动器：Windows、.NET Framework 4.7.2+、Windows PowerShell。
- Android：JDK 17、Android SDK Platform 35、Build Tools 35.0.0；见 [Android README](../android/README.md)。
- NAS 镜像：有 Docker 引擎、能运行目标 AMD64 / ARM64 架构的 Linux 环境，或使用手动云构建流程。

`public/` 是实际服务使用的前端，无独立前端打包步骤。`ui/` 保留早期设计原型，其演示数据不等于实际功能。修改正式界面请编辑 `public/`。

## 验证命令

```sh
npm run check
npm test
npm run test:deployment
```

`npm test` 使用本地临时服务和测试数据，不依赖公开片源。部署测试覆盖配置解析、数据卷复用、镜像校验和 Windows ZIP 打包，使用模拟 Docker 或合成镜像夹具；缺少所需 shell / 平台时部分测试会跳过。真实播放、摄像头、遥控器与容器重建应另外验收。

以下是需要联网的手动片源检测，不作为 CI 的通过条件：

```sh
node scripts/probe-sources.mjs
node scripts/smoke-live.mjs
```

结果保存在被 Git 忽略的 `test-results/`。

## Windows 构建

在已安装依赖的项目根目录运行：

```powershell
.\scripts\build-server-launcher.ps1
.\scripts\package-server.ps1
.\scripts\package-player.ps1
```

`package-server.ps1` 使用 `-NasOfflineBundle` 指向已校验的 AMD64 离线包，使用 `-NasArm64OfflineBundle` 指向 ARM64 离线包。两者分目录收录；未提供某架构镜像时，启动器对此架构明确显示源码部署。大体积发行文件保存在 `release/`，不提交到源码仓库。

## NAS 构建

源码部署使用根目录 `Dockerfile` 与 `docker-compose.yml`。通用 NAS 部署包由 `scripts/package-nas.ps1` 生成。离线镜像按 [使用说明](usage.md) 和 [离线模板说明](../deployment/nas-offline/README.md) 构建、验收和打包。

`scripts/package-nas.ps1 -Architecture arm64` 生成指定平台的 ARM64 源码包。实际离线镜像可运行 `sh scripts/build-nas-image.sh <输出目录> arm64`，或触发 `nas-offline.yml`；详见 [NAS 架构与 Windows 导出](nas-architectures.md)。两种架构均已有真实容器验收的离线镜像；ARM64 于 2026-11-27 在 GitHub 原生 ARM64 执行机制作。

## 源码导出

```sh
npm run prepare:github -- release/github/yingjian
```

导出器使用 Git 可见文件列表，保留代码、测试、示例配置、第三方 JAR、原型素材和文档；拒绝敏感文件名、已知令牌模式、符号链接和超大文件。输出路径必须位于当前项目的 `release/` 内，已存在时拒绝覆盖。该检查不能保证发现所有形式的秘密，上传前仍应检查文件清单。

上传目录不包含 `.git`、`node_modules/`、`data/`、`deliverables/`、测试结果、Android 签名目录和构建缓存。导出清单与 SHA-256 在目录旁边的 `yingjian.manifest.json`，不会混入源码目录。

原有 `scripts/package-source.ps1` 仍用于版本化源码发布包；它同样保留正式源码、Android、设计原型和仓库文档。

## 持久化与兼容性

不要为截图、演示或测试修改正在使用的 `data/household.json`。测试应指定独立临时数据目录。修改 API 时同步维护 [API-CONTRACT.md](../API-CONTRACT.md)；修改配对和播放流程时检查手机、电脑与电视布局。

CI 使用官方 [actions/checkout](https://github.com/actions/checkout) 与 [actions/setup-node](https://github.com/actions/setup-node)，权限仅为读取源码。它只运行检查，不自动发布安装包或部署服务。
