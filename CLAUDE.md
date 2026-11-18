# wanneng2api — 协作规则

## 发布流程（唯一入口：GitHub Actions）

桌面版发布**一律走 `.github/workflows/release.yml`**，不在本地跑 electron-builder、
也不再手动 `gh release upload`：

1. 提交所有改动，并把 `shell/package.json` 的 `version` 升到目标版本，提交
   `chore(release): X.Y.Z`；
2. 推送 master；
3. 打 tag 并推送：
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. Actions 自动完成：预检版本一致性 → Ubuntu 构建 Linux（AppImage + deb +
   latest-linux.yml）→ Windows runner 构建 nsis（setup.exe + latest.yml）→
   资产挂到同名 Release（已存在则 `--clobber` 覆盖）→ **删除本次 Actions 工件**。
5. 补发/重跑：Actions 页面手动触发 `release`，输入已存在的 tag。

约定：
- tag 名必须 `v` + `shell/package.json` 版本，否则 preflight 直接失败。
- Release 资产必须同时包含 Windows（`latest.yml`）与 Linux（`latest-linux.yml`），
  壳的自更新依赖这两份清单。
- 不再保留 Actions 工件：发布成功后由工作流自行删除，避免配额被 100MB+ 工件占满。
- Android APK 由 `release.yml` 的 `android` job 构建（ubuntu + JDK17 + Gradle），
  以 `wanneng2api-android-<version>-arm64.apk` 随同一 Release 发布；版本号取自
  `shell/package.json`，无需单独升 `android/` 的版本。

验证命令（本地代理/网络受限时也可用）：
```bash
gh release view vX.Y.Z --json assets
gh run list --limit 3
```

## 代码约定

- `shell/src` 除 `main.js` / `preload.js` / `tray.js` 外必须是纯 Node 模块（无 Electron
  依赖），以便 headless（`shell/server.js`）与回归测试复用。
- 构造 `PlatformUpdater` 等依赖 `dataDir` 的类时务必显式传入；headless 与 Electron
  两个入口都要覆盖。
- 改 `shell/` 或 `ui/` 后，如果同时维护 Android 壳，必须升 `android/app/build.gradle.kts`
  的 `versionName`（容器 payload 按它判断是否刷新）。