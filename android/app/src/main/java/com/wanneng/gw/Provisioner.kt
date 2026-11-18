package com.wanneng.gw

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.Paths as NioPaths
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream

/**
 * 首启运行环境准备：Ubuntu arm64 rootfs + Node（linux-arm64）+ 释放 Node 壳与 UI。
 *
 * 下载与解压都尽量做成幂等：rootfs / node 以标记文件判定，已就绪则跳过。
 */
class Provisioner(private val ctx: Context) {

    data class State(
        val stage: String,
        val message: String,
        val ready: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State("init", "准备中"))
    val state: StateFlow<State> = _state

    private val rootfs: File get() = Paths.rootfs(ctx)

    suspend fun provision(): Boolean {
        try {
            installRootfs()
            writeNetworkConf()
            val node = ensureNode()
            ensurePython()
            releasePayload()
            _state.value = State("ready", "运行环境就绪", ready = true)
            Log.i(TAG, "provision done, node=${node.absolutePath}")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "provision failed", e)
            _state.value = State("error", "运行环境准备失败", error = e.message)
            return false
        }
    }

    /** 已就绪则跳过。 */
    fun isReady(): Boolean =
        File(rootfs, ".rootfs-ready").exists() &&
        Paths.nodeInside(rootfs) != null &&
        File(Paths.payloadInside(rootfs), "shell/server.js").exists()

    // ---------------------------------------------------------------- rootfs

    private fun installRootfs() {
        if (File(rootfs, ".rootfs-ready").exists()) return
        val archive = File(rootfs, "rootfs.tar.gz")
        // 允许预置归档（弱网时由外部推入），存在则直接解压。
        if (!archive.exists() || archive.length() == 0L) {
            _state.value = State("rootfs", "下载 Ubuntu arm64 基础环境")
            downloadAny(ROOTFS_URLS, archive, "rootfs")
        }
        _state.value = State("rootfs", "解压 Ubuntu 基础环境")
        // 清理上次失败留下的残留，避免新旧文件混在一起。保留两个归档。
        rootfs.listFiles()?.filter { it.name !in setOf("rootfs.tar.gz", "node.tar.gz") }
            ?.forEach { it.deleteRecursively() }
        rootfs.mkdirs()
        extract(archive, rootfs, strip = 0)
        File(rootfs, ".rootfs-ready").createNewFile()
    }

    private fun writeNetworkConf() {
        // 精简 rootfs 没有 /etc/resolv.conf，Go 的纯 resolver 与 glibc 都靠它解析。
        File(rootfs, "etc/resolv.conf").writeText(
            "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 223.5.5.5\n"
        )
        File(rootfs, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
    }

    // ------------------------------------------------------------------ node

    private fun ensureNode(): File {
        val existing = Paths.nodeInside(rootfs)
        if (existing != null) {
            val code = ContainerManager.get(ctx).runBlocking(
                Paths.containerPath(rootfs, existing), listOf("--version"),
                onLine = { Log.i(TAG, "node> $it") },
            )
            if (code == 0) return existing
        }
        _state.value = State("node", "下载 Node.js arm64")
        val cache = File(rootfs, "node.tar.gz")
        if (!cache.exists() || cache.length() == 0L) {
            downloadAny(NODE_URLS, cache, "node")
        }
        _state.value = State("node", "安装 Node.js")
        // 解压到临时目录后整目录搬到 /usr/local（避免依赖 tar --strip-components，
        // Android toybox tar 对它的兼容性不稳定）。
        val tmp = File(rootfs, "tmp/node-extract").apply { deleteRecursively(); mkdirs() }
        extract(cache, tmp, strip = 0)
        val top = tmp.listFiles()?.firstOrNull { it.isDirectory }
            ?: throw IllegalStateException("node 包结构异常")
        copyRecursive(top, File(rootfs, "usr/local"))
        tmp.deleteRecursively()
        cache.delete()
        // Kotlin 拷贝不保留可执行位，补上 bin/ 下所有文件。
        File(rootfs, "usr/local/bin").listFiles()?.forEach { it.setExecutable(true) }

        val node = Paths.nodeInside(rootfs)
            ?: throw IllegalStateException("未找到 node 可执行文件")

        // 部分精简 rootfs 缺 libstdc++6，node 会启动失败（exit 127）。
        val nodePath = Paths.containerPath(rootfs, node)
        val code = ContainerManager.get(ctx).runBlocking(
            nodePath, listOf("--version"),
            onLine = { Log.i(TAG, "node> $it") },
        )
        if (code != 0) {
            _state.value = State("node", "补齐 Node 依赖（libstdc++6）")
            installApt("libstdc++6")
            val code2 = ContainerManager.get(ctx).runBlocking(
                nodePath, listOf("--version"),
                onLine = { Log.i(TAG, "node> $it") },
            )
            if (code2 != 0) throw IllegalStateException("node --version 仍失败（exit=$code2）")
        }
        return node
    }

    /** Loomy 是 Python 网关，rootfs 需要 python3；失败不阻塞其余网关。 */
    private fun ensurePython() {
        if (File(rootfs, "usr/bin/python3").exists()) return
        _state.value = State("python", "安装 Python 运行时")
        runCatching { installApt("python3") }
            .onFailure { Log.w(TAG, "python3 安装失败（Loomy 将不可用）: ${it.message}") }
    }

    private fun installApt(pkg: String) {
        File(rootfs, "etc/apt/sources.list").writeText(APT_SOURCES)
        val mgr = ContainerManager.get(ctx)
        mgr.runBlocking("/usr/bin/apt-get", listOf("update"), timeoutSec = 600,
            onLine = { Log.i(TAG, "apt> $it") })
        mgr.runBlocking(
            "/usr/bin/apt-get",
            listOf("install", "-y", "--no-install-recommends", pkg),
            timeoutSec = 600,
            onLine = { Log.i(TAG, "apt> $it") },
        )
    }

    // --------------------------------------------------------------- payload

    private fun releasePayload() {
        val payload = Paths.payloadInside(rootfs)
        val marker = File(payload, ".payload-version")
        val expected = BuildConfig.VERSION_NAME
        if (marker.exists() && marker.readText().trim() == expected) return

        _state.value = State("payload", "释放 Node 壳与管理界面")
        payload.deleteRecursively()
        payload.mkdirs()
        // Gradle 把生成目录直接当作 assets 根，所以资产位于 assets/shell、assets/ui。
        copyAssetTree("shell", File(payload, "shell"))
        copyAssetTree("ui", File(payload, "ui"))
        marker.writeText(expected)
    }

    private fun copyAssetTree(assetRoot: String, dest: File) {
        dest.mkdirs()
        val entries = ctx.assets.list(assetRoot) ?: return
        for (entry in entries) {
            val childPath = "$assetRoot/$entry"
            val out = File(dest, entry)
            val nested = ctx.assets.list(childPath)
            if (nested != null && nested.isNotEmpty()) {
                copyAssetTree(childPath, out)
            } else {
                ctx.assets.open(childPath).use { it.copyTo(out.outputStream()) }
            }
        }
    }

    // --------------------------------------------------------------- helpers

    private fun downloadAny(urls: Array<String>, dest: File, label: String) {
        val tmp = File(dest.parentFile, "${dest.name}.part")
        tmp.delete()
        dest.parentFile?.mkdirs()
        val tried = mutableListOf<Throwable>()
        for (u in urls) {
            runCatching {
                val c = URL(u).openConnection() as HttpURLConnection
                c.connectTimeout = 15000
                c.readTimeout = 60000
                c.instanceFollowRedirects = true
                c.useCaches = false
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) w2a-provisioner")
                when (c.responseCode) {
                    in 200..299 -> {
                        c.inputStream.use { it.copyTo(tmp.outputStream()) }
                        if (tmp.exists() && tmp.length() > 0) {
                            tmp.renameTo(dest)
                            Log.i(TAG, "$label downloaded from $u (${dest.length()} bytes)")
                            return
                        }
                        throw IOException("空响应")
                    }
                    else -> throw IOException("HTTP ${c.responseCode}")
                }
            }.onFailure {
                tried.add(it)
                Log.w(TAG, "$label 从 $u 下载失败: ${it.message}")
            }
        }
        throw IllegalStateException("$label 全部镜像下载失败: ${tried.joinToString()}")
    }

    /**
     * 用 commons-compress 解压 tar.gz。
     *
     * 原因：Android 没有 java.util.tar；系统 toybox tar 会按归档 uid/gid 逐个
     * `chown 0:0`，而 App 私有目录（FUSE）不允许 chown，Ubuntu 基础包每文件都报
     * "Operation not permitted" 并以 exit 1 失败。
     *
     * **必须正确处理符号链接**：Ubuntu base 有大量 `/bin->usr/bin`、`/lib->usr/lib`
     * 等软链。若把软链写成空普通文件，/lib 会变成 0 字节文件、/lib64 缺失，
     * proot 加载 ELF 解释器时报 `execve(...): Not a directory`。
     */
    private fun extract(archive: File, dest: File, strip: Int) {
        dest.mkdirs()
        FileInputStream(archive).use { fis ->
            GzipCompressorInputStream(fis).use { gz ->
                TarArchiveInputStream(gz).use { tar ->
                    var entry: TarArchiveEntry? = tar.nextTarEntry
                    while (entry != null) {
                        val name = entry.name
                        val slash = name.indexOf('/')
                        val rel = if (strip > 0 && slash > 0) name.substring(slash + 1) else name
                        val out = File(dest, rel)
                        when {
                            entry.isDirectory -> out.mkdirs()
                            entry.isSymbolicLink -> {
                                out.parentFile?.mkdirs()
                                Files.createSymbolicLink(out.toPath(), NioPaths.get(entry.linkName))
                            }
                            entry.isLink -> { // 硬链接：退化为普通文件，避免依赖 linkat
                                out.parentFile?.mkdirs()
                                FileOutputStream(out).use { tar.copyTo(it) }
                                if ((entry.mode and 0x49) != 0) out.setExecutable(true)
                            }
                            else -> {
                                out.parentFile?.mkdirs()
                                FileOutputStream(out).use { tar.copyTo(it) }
                                // Android 的 FUSE 忽略可执行位，但 proot 靠 mode 判断可执行，必须补上。
                                if ((entry.mode and 0x49) != 0) out.setExecutable(true)
                            }
                        }
                        entry = tar.nextTarEntry
                    }
                }
            }
        }
    }

    private fun copyRecursive(src: File, dest: File) {
        dest.mkdirs()
        src.listFiles()?.forEach { f ->
            val out = File(dest, f.name)
            if (f.isDirectory) {
                copyRecursive(f, out)
            } else {
                f.inputStream().use { it.copyTo(out.outputStream()) }
                if (out.name.contains("bin") || out.name.endsWith(".node") || out.name.endsWith(".sh")) {
                    out.setExecutable(true)
                }
            }
        }
    }

    companion object {
        private const val TAG = "W2AProvision"

        private val ROOTFS_URLS = arrayOf(
            "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz",
            "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz",
            "https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz",
        )

        private val NODE_URLS = arrayOf(
            "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-arm64.tar.gz",
            "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v20.18.0/node-v20.18.0-linux-arm64.tar.gz",
            "https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-linux-arm64.tar.gz",
        )

        private val APT_SOURCES = """
            deb http://ports.ubuntu.com/ubuntu-ports noble main universe
            deb http://ports.ubuntu.com/ubuntu-ports noble-updates main universe
            deb http://ports.ubuntu.com/ubuntu-ports noble-security main universe
        """.trimIndent() + "\n"
    }
}
