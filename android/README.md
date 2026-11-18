# wanneng2api — Android 壳

把一个 APK 变成手机上的完整网关平台：WebView 打开管理台，控制面（Node）与四个自研网关
跑在 APK 内的 **proot 容器**里，不需要 root，也不依赖 Termux。

```
WebView (127.0.0.1:17800)
 └── ApiBridge (原生 HTTP，NO_PROXY) ──┐
                                      ▼
GatewayService (前台服务 + WAKE_LOCK)
 └── proot -r filesDir/linux ── node /opt/payload/shell/server.js
                                 ├── Manager API :17800（托管网关进程）
                                 └── 四网关 / magpie（壳自行下载 arm64 资产）
```

## 构建（版本号取自 shell/package.json）

发布由 `.github/workflows/release.yml` 的 `android` job 完成：推送 `v*` tag 后自动产出
`wanneng2api-android-<version>-arm64.apk` 并挂到同一 Release。**不要单独升这里的版本号**，
`shell/package.json` 的 `version` 同时决定 APK 的 `versionName` 与容器 payload 是否刷新。

前置：JDK 17、Android SDK（`local.properties` 的 `sdk.dir` 或 `ANDROID_HOME`）、
已构建的 `ui/dist`、`shell/node_modules/adm-zip`。

```bash
cd ui && npm install && npm run build && cd ..     # 仓库根的 UI
cd shell && npm pack adm-zip@0.6.1                 # 解包到 shell/node_modules/adm-zip
                                                   # （loomy 的 .zip 解压需要）
cd android && ./gradlew :app:assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk（arm64-v8a）
```

`shell/node_modules/adm-zip` 只在没有该目录时需要手动准备；Gradle 的 `stagePayload`
会校验并把 `shell/`（源码）与 `ui/dist/` 一起打进 APK 资产。

## 首启流程（Provisioner）

1. 下载 `ubuntu-base-24.04.x-base-arm64.tar.gz` 并用 **commons-compress** 解压
   （Android 没有 `java.util.tar`；系统 tar 会对每个文件 `chown 0:0` 而失败）。
   **必须保留符号链接**：`/lib → usr/lib` 若被写成普通空文件，proot 会报
   `execve(...): Not a directory`。
2. 写 `/etc/resolv.conf`。
3. 安装 Node（linux-arm64）到 `/usr/local`，缺 `libstdc++6` 时用 apt 补。
4. 用 apt 安装 `python3`（Loomy 需要；失败只告警）。
5. 把 APK 里的 `shell/` 与 `ui/` 释放到 `linux/opt/payload`（按 `versionName` 判定，
   **改了 shell/UI 必须升 `shell/package.json` 的 version**，否则容器里仍是旧脚本）。
6. 前台服务在容器内执行 `node /opt/payload/shell/server.js`。

弱网机器可以把 `rootfs.tar.gz`、`node.tar.gz` 预置到
`/data/data/com.wanneng.gw/files/linux/`，Provisioner 会跳过下载。

## 为什么不用 WebView 直连 17800

Android WebView（Chromium）会把 `http://127.0.0.1:17800` 也交给系统 HTTP 代理。
设备开了 LAN 代理时，页面直接 `ERR_CONNECTION_REFUSED`（Java `HttpURLConnection`
对 loopback 自动绕过代理，所以"探活正常、页面打不开"）。因此：

- `WebViewClient.shouldInterceptRequest`：页面静态资源直接从 APK 资产返回；
- `ApiBridge`（`@JavascriptInterface`）+ `ui/public/w2a-bridge.js`：把 `fetch`
  改走 App 进程的 `Proxy.NO_PROXY` 直连；
- `window.__W2A_ANDROID__ = true`：日志页走已有的去重轮询（无 SSE）；
- 「打开面板」等外链由 `ApiBridge.openExternal` 起系统浏览器。

## proot 要点

- proot 全套（`libproot.so` / 两个 loader / `libtalloc` / `libandroid-shmem`）放在
  `jniLibs`，配合 `useLegacyPackaging`，安装后位于唯一允许 `execve` 的 `nativeLibraryDir`。
- 启动参数：`-r <rootfs> -0 -b /dev -b /proc -b /sys -b /system [-b /apex]
  --link2symlink -w /root`，环境变量 `PROOT_TMP_DIR` / `PROOT_LOADER` /
  `PROOT_LOADER_32` / `LD_LIBRARY_PATH` 必须指向 nativeLibraryDir。
- **程序路径传容器内路径**（`/usr/local/bin/node`），传宿主绝对路径会 `not found`。

## 端口

17800 管理台，7863 WorkBuddy，7866 CodeArts，17990 Loomy，6789 Lingxi，3425 magpie，
17899 magpie-web（均在 127.0.0.1）。

## 限制

- 仅 arm64-v8a；ABI 过滤在 `app/build.gradle.kts`。
- 空账号池的网关显示「待添加账号」（不是异常）：`/healthz` 的 503 在
  `platform-manager.js` 的 `isEmptyPoolBody` 里识别。
- 部分 ROM（ColorOS/MIUI 等）需用户手动允许自启动/后台运行，前台服务与
  WAKE_LOCK 无法对抗厂商冻结策略。
- 发行包目前使用 debug 签名；正式分发前应在 `android/keystore.properties`
  配置自己的 keystore 并打 release 包。