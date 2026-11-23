# 映间服务端 · 通用 Docker / NAS

这是服务端部署包。它在 NAS 上保存片源、连接设备和播放进度；电脑、安卓手机、安卓电视作为播放端连接同一个服务。Windows 播放端不需要部署本包。

## 首次部署

1. 在 NAS 上安装并启动 Docker / Container Manager，准备支持 Compose 的环境。
2. 将 Windows 服务端启动器导出的整个文件夹上传到 NAS。不要只上传 `docker-compose.yml`：构建需要同级 `server`、`public`、`config`、`package.json` 和 `package-lock.json`。
3. 如果使用通用未配置压缩包，复制 `.env.example` 为 `.env`，填写 NAS 的局域网 IPv4、端口和 12–128 位管理密码。启动器导出的包已包含配置。
4. 在该文件夹执行 `sh deploy.sh start`。首次构建需要下载 Node 基础镜像和 npm 依赖；NAS 必须能访问这些镜像和软件源。
5. 浏览器打开配置的地址，例如 `http://192.168.1.100:8080`，使用管理密码登录。播放端使用该地址加连接码连接；手机也可扫描管理页的二维码。

若 NAS 提供 Compose 项目界面，也可导入此文件夹中的 `docker-compose.yml`，使用同级 `.env` 并执行构建、启动。不同厂商读取 `.env` 的方式可能不同；若界面要求填写变量，按下面表格逐项填写。Docker 内部端口固定为 8080，外部端口可改。

| 变量 | 填写内容 |
| --- | --- |
| `ADMIN_PASSWORD` | 自己设置的 12–128 位管理密码 |
| `LAN_BIND_IP` | NAS 实际局域网 IPv4，例如 `192.168.1.100` |
| `HOST_PORT` | NAS 对外监听端口，默认 `8080` |
| `PUBLIC_ORIGIN` | 与上两项一致，例如 `http://192.168.1.100:8080` |
| `DATA_VOLUME` | 新部署默认 `yingjian-data`；升级时填写旧服务实际数据卷名 |
| `NODE_IMAGE` | 可选的完整基础镜像名称，默认 `public.ecr.aws/docker/library/node:24-alpine`；需要与实际可下载的仓库、标签或摘要一致 |

`.env` 支持上述六个变量，每行一个 `KEY=value`。旧启动器导出的五项配置仍可使用，省略 `NODE_IMAGE` 时采用默认值。密码使用单引号包裹，允许 `$`、`#` 等字符，不能包含单引号、反斜杠、换行或控制字符。例如 `ADMIN_PASSWORD='My$Local#Password2026'`。脚本不会把 `.env` 当作 shell 代码执行。请将配置文件仅授权给 NAS 管理者；不要公开分享含 `.env` 的部署包。

## 飞牛 NAS 镜像地址与旧包升级

当前默认基础镜像为 `public.ecr.aws/docker/library/node:24-alpine`。2026-11-16，用户已在飞牛 NAS 的 x86-64 环境中成功拉取此镜像，并完成旧版应用镜像的构建。容器随后因无法读取 `/app/package.json` 而退出；新版 Dockerfile 已加入权限修复，修复版的重新构建与启动仍需在 NAS 上确认。

当前 Compose 文件仅使用本地 `build`，不再声明未发布到镜像仓库的 `yingjian-server:local`，避免先尝试远程拉取这个应用镜像。基础镜像本身仍需要可用的下载路径。

从仍使用旧镜像地址的部署包升级时：

1. 将新版包中的 `Dockerfile`、`docker-compose.yml` 和 `deploy.sh` 一起覆盖到 NAS 原部署目录，保留原 `.env`、项目名和数据卷。
2. 旧 `.env` 没有 `NODE_IMAGE` 时，无需新增这一项，三个部署文件都会采用新的默认镜像。如果已经填写过 `NODE_IMAGE`，将该行改成下面的值，不要重复添加同名键。
3. 在飞牛原 Compose 项目中更新编排内容并重新构建启动。若界面保存了独立的编排文本，仅覆盖磁盘文件可能不会更新它；确认界面中的 `build.args.NODE_IMAGE` 默认值也已变更。

已经设置过镜像变量时，使用：

```dotenv
NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine
```

也可在原部署目录执行：

```sh
sh deploy.sh validate
sh deploy.sh start
```

之前出现的 Docker Hub 超时和 `docker.fnnas.com` 返回 `401 Unauthorized` 都发生在镜像访问阶段。更新 NAS 应用中心的 Node.js 不会改变 Docker 基础镜像。若新环境仍无法下载，可单独执行 `docker pull public.ecr.aws/docker/library/node:24-alpine` 确认下载结果，再检查网络或使用已确认可访问的完整镜像地址。

已下载的镜像必须与配置的仓库和标签一致。构建仍可能检查远端元数据，且随后会执行 `npm ci` 下载项目依赖；本包不是离线镜像包。如果失败位置已变成 `RUN npm ci`，请检查该步骤的具体日志。

## 构建成功后提示 package.json 权限不足

如果运行日志出现 `Cannot read package config /app/package.json: permission denied`，说明容器已开始运行 Node，但运行用户无法读取应用文件。旧 Dockerfile 复制文件后未统一应用权限；NAS 上传或解压得到的文件权限过严时，以 root 执行的构建仍可能成功，而切换到 `USER node` 后启动失败。

新版 Dockerfile 会在构建时明确设置应用目录的遍历权限和应用文件的读取权限，并保留 `USER node`。切换用户后还会只读导入服务模块、读取配置及页面文件，提前核验运行用户能否访问应用内容；该检查不启动服务、不打开家庭数据。权限调整针对镜像内的程序文件，不修改现有 `/app/data` 数据卷。

已经使用上述 ECR 镜像地址、并且构建成功的部署，只需执行本次权限修复：

1. 将新版包中的 `Dockerfile` 覆盖到 NAS 原部署目录，保留原 `.env`、Compose 项目和数据卷。
2. 在原 Compose 项目中重新构建镜像，并更新容器使其使用新镜像；仅点击“重启”旧容器不会应用修复。
3. 查看新容器的运行日志，确认出现“映间局域网服务已启动”，再通过原局域网地址访问。

也可在原部署目录执行 `sh deploy.sh start`，由脚本构建并启动服务。本次无需更换 Node 版本、修改访问端口或删除数据卷。当前已确认旧版在用户 NAS 上构建成功，新权限修复版的实际启动结果仍待验证。

## 管理与升级

```sh
sh deploy.sh validate  # 只校验配置，不连接 Docker
sh deploy.sh status    # 查看运行状态及健康检查
sh deploy.sh stop      # 停止服务，保留配置和播放数据
sh deploy.sh start     # 构建并启动，或重新启动
sh deploy.sh update    # 更新镜像并重建容器，保留数据
```

升级应用时，将新版服务端文件覆盖到原部署目录，保留原 `.env`，然后执行 `sh deploy.sh update`。`update` 会构建当前目录中的代码，不会自动下载新版本的映间源码。不要使用 `docker compose down -v`，它会删除数据卷。

此前版本的 `docker-compose.yml` 会创建类似 `文件夹名_yingjian-data` 的数据卷。新脚本会优先识别现有 `yingjian-lan` 容器的 `/app/data` 挂载，保留原 Compose 项目并把实际数据卷名写回 `.env`；容器已被删除时，只在找到唯一旧卷时自动复用。发现多个旧数据卷或配置冲突时会停止，请明确选择原数据卷再继续。旧容器为手工创建或使用目录挂载时，脚本会保留它并报告需要手工迁移。

直接通过 NAS 的 Compose 界面升级不会执行这个识别步骤：请先在旧容器的挂载信息中找到 `/app/data` 对应的卷，填入 `DATA_VOLUME`。重新导入项目时保持原项目名；不要新建第二个同名容器。部署前可使用 NAS 自带的备份功能备份原数据卷。

## 运行条件与范围

本包默认使用 `public.ecr.aws/docker/library/node:24-alpine` 基础镜像，供支持该镜像的平台构建；按常见 NAS 的 x86-64 或 ARM64 架构使用对应 Docker 环境，不需要强制指定 `platform`。目前用户已确认飞牛 x86-64 环境可拉取基础镜像并完成旧版应用构建；旧版容器遇到的应用文件读取权限问题已在 Dockerfile 中修复，修复版的 NAS 构建与运行仍待验证。具体 CPU 架构、系统版本及内存限制仍需以实际结果为准。

服务仅发布在配置的局域网 IPv4 上，不使用特权容器或宿主网络。手机和电视需要能访问该局域网地址；不要配置公网端口映射。该方案不依赖额外的公网服务端，但在线片源本身仍可能需要互联网。NAS 防火墙应允许本地设备访问所选端口，路由器宜为 NAS 保留固定局域网地址。

数据卷保存服务端的片源、设备与播放进度，不保存影视文件。停止或重建容器后数据卷保留；删除数据卷则会丢失这些数据。

## 异常退出后无法启动

正常停止会保存数据并释放 `.yingjian-server.lock`；同一容器异常重启时，程序也会根据 Linux 进程身份识别过期锁。如果容器被强制终止后又重新创建，容器名称空间或主机标识发生变化，程序可能无法确认旧实例已退出，从而拒绝打开数据目录。

此时先确认没有任何旧映间容器或服务正在使用这个数据卷，再通过 NAS 的卷文件管理功能移除卷内 **`.yingjian-server.lock` 目录**，重新启动。保留 `household.json` 和其他数据；服务运行时不要手动删锁。如果无法确认旧服务是否停止，请先检查容器列表和日志。

参考 Docker 官方文档：Compose 环境变量插值、命名卷和项目名称规则。部署前若厂商要求不同的导入方式，请按其 Docker 管理界面完成导入。
