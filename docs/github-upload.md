# 上传到 GitHub：yingjian

建议仓库名称：`yingjian`。

建议仓库描述：

> 映间 · 局域网家庭影音，支持 Windows / NAS 部署，手机、电脑、安卓电视共享片源、收藏与观看进度。作者：雪落a。

建议 Topics：`yingjian`、`home-cinema`、`lan`、`nas`、`docker`、`android-tv`、`video-player`。

## 已准备的内容

所有正式代码、构建与部署脚本、Android 工程、测试、原型、文档，以及 GitHub CI 和反馈模板。安装包、家庭数据、密钥和截图大包由忽略规则排除。

作者暂未选择许可证，因此不要在创建仓库时替作者选择 MIT、Apache-2.0 或其他许可证。可见性由作者自行决定。

## 方法一：上传干净源码目录

1. 在本项目执行 `npm run prepare:github -- release/github/yingjian`，或使用已经整理好的 `yingjian` 目录。
2. 在自己的 GitHub 账号下创建空仓库 `yingjian`；不要额外初始化 README、许可证或 `.gitignore`，避免首次推送冲突。
3. 在导出的 `yingjian` 目录内打开终端，执行下面的命令。将 `YOUR_ACCOUNT` 替换为真实 GitHub 用户名；不要把访问令牌写入 URL。

```sh
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial import of Yingjian 0.1.4"
git remote add origin https://github.com/YOUR_ACCOUNT/yingjian.git
git push -u origin main
```

Git 提交需要使用你自己的姓名和邮箱配置；请按自己的隐私偏好选择邮箱。若远端已有内容，应先克隆再合并，不使用强制推送覆盖远端。

也可以通过 GitHub Desktop 将导出目录初始化为本地仓库后发布。上传目录的内容，而不是把源码 ZIP 当成唯一文件提交；否则首页、代码浏览和 CI 不会按预期工作。

## 方法二：保留当前工作目录

当前目录的 `.gitignore` 已排除本地数据和产物。先检查 `git status --short` 和准备提交的文件，再自行提交和关联远端。无需移动或删除 `data/`、`release/` 和 `deliverables/`。

## 成品发布

源码推送成功后，再按需创建 Release，并把 Windows ZIP、手机/电视 APK 和 NAS 离线 ZIP 作为附件上传。只上传未包含个人 `.env`、家庭数据和日志的通用包；不要上传启动器导出的带个人管理密码配置的 NAS 包。

CI 会在源码推送后运行检查。Windows、Ubuntu 或 Node 版本矩阵尚未在 GitHub 上执行时，不将其标记为已通过。Android APK、Windows WPF 程序和 Docker 镜像仍需要对应环境单独构建和验证。
