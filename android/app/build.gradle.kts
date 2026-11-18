import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 仓库根 = android/ 的上一级，里面有 shell/ 与 ui/。
val repoRoot: File = rootProject.projectDir.parentFile

// 版本与桌面壳保持一致：发布只升 shell/package.json 一处，
// buildConfig 的 VERSION_NAME 同时决定容器 payload 是否刷新。
val shellVersion: String = runCatching {
    Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
        .find(repoRoot.resolve("shell/package.json").readText())
        ?.groupValues?.get(1)
}.getOrNull() ?: "0.0.0"

// 由 a.b.c 映射出一个单调递增的 versionCode（0.2.8 -> 2008）。
val shellVersionCode: Int = shellVersion
    .split('.', '-')
    .mapNotNull { it.takeWhile(Char::isDigit).toIntOrNull() }
    .let { (it.getOrNull(0) ?: 0) * 10000 + (it.getOrNull(1) ?: 0) * 100 + (it.getOrNull(2) ?: 0) }

android {
    namespace = "com.wanneng.gw"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.wanneng.gw"
        minSdk = 26          // Android 8.0：前台服务 + nativeLibraryDir 执行
        targetSdk = 34
        versionCode = shellVersionCode
        versionName = shellVersion

        ndk {
            // 只出 arm64（proot 全套与 Node 均为 arm64）；模拟器可另加 x86_64
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            // WebView 壳无需混淆；保持 release 可安装
            isMinifyEnabled = false
            isShrinkResources = false
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }

    packaging {
        jniLibs {
            // proot 必须解压到 nativeLibraryDir（唯一允许 execve 的位置），
            // 否则 .so 直接从 APK 映射，execve 得到 ENOENT。
            useLegacyPackaging = true
            keepDebugSymbols += setOf(
                "**/libproot.so", "**/libproot-loader.so", "**/libproot-loader32.so",
                "**/libtalloc.so", "**/libandroid-shmem.so",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 把 Node 控制面（shell）与已构建的 UI（ui/dist）打进 assets/payload。
// 运行时首启释放到 rootfs/opt/payload，再由容器内 node 执行 shell/server.js。
// 注意：server.js 在无代理、tar 模式下不 require 任何外部 npm 包，
// 因此这里只带源码，不需要 node_modules。
// ---------------------------------------------------------------------------
val stagePayload = tasks.register<Copy>("stagePayload") {
    group = "build"
    description = "汇总 shell + ui/dist 到 assets"

    val uiDist = repoRoot.resolve("ui/dist")
    if (!uiDist.resolve("index.html").exists()) {
        throw GradleException(
            "缺少 ui/dist/index.html。请先在仓库根执行：cd ui && npm install && npm run build"
        )
    }

    val outDir = layout.buildDirectory.dir("generated/payload").get().asFile
    doFirst {
        outDir.deleteRecursively()
        outDir.mkdirs()
    }
    from(repoRoot.resolve("shell")) {
        include("server.js", "src/**")
        into("shell")
    }
    // loomy 的 release 是 .zip，updater 用 adm-zip 解压（纯 JS，无原生依赖）。
    // 其余网关走 .tar.gz 由系统 tar 处理，不需要 node_modules。
    val admZip = repoRoot.resolve("shell/node_modules/adm-zip")
    if (!admZip.resolve("adm-zip.js").exists()) {
        throw GradleException(
            "缺少 shell/node_modules/adm-zip（.zip 网关解压需要）。" +
                "请在 shell/ 下执行：npm pack adm-zip@0.6.1 后解包到 node_modules/adm-zip"
        )
    }
    from(admZip) { into("shell/node_modules/adm-zip") }
    from(uiDist) { into("ui/dist") }
    into(outDir)
}

android.sourceSets.getByName("main").assets.srcDir(
    layout.buildDirectory.dir("generated/payload").get().asFile
)

tasks.matching { it.name.startsWith("preBuild") }.configureEach {
    dependsOn(stagePayload)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // 纯 Java 的 tar/gzip 解压。Android 没有 java.util.tar，系统 toybox tar 会
    // 按归档 uid/gid 逐个 chown（App 私有目录不允许），必须用 commons-compress。
    implementation("org.apache.commons:commons-compress:1.26.2")
}
