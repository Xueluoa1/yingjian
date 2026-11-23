# 第三方组件与来源

映间使用以下开源组件。确切版本和传递依赖见 `package-lock.json`；便携包保留 `node_modules` 中各包的许可证文件。

| 组件 | 用途 | 上游许可证 |
| --- | --- | --- |
| Node.js | Windows 便携运行环境、服务端运行时 | MIT 及随附第三方声明；见 `runtime/LICENSE` |
| Express | HTTP 服务 | MIT |
| hls.js | 浏览器 HLS 播放 | Apache-2.0 |
| ipaddr.js | 地址解析与网络范围判断 | MIT |
| qrcode | 配对二维码生成 | MIT |
| undici | HTTP 上游请求 | MIT |
| ZXing core | Android 离线二维码识别 | Apache-2.0；Android 工程内保留声明 |

预置接口名单由用户指定的仓库提供：
https://github.com/ximishan/LibreTV-api-source

导入日期：2026-11-12。README 对应 Git 对象 SHA：`f018e2a8e14c262b422dbd8f7065abb3ea96aba3`。这里只保存公开接口地址和名称，影片、海报及媒体不随安装包分发，也不由本项目托管。

LibreTV 项目为最初的兼容需求参考；当前服务端、界面与安卓客户端为本项目独立实现，未包含其源代码。
