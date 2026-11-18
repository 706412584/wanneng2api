package com.wanneng.gw

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * proot 容器管理器（进程级单例）。
 *
 * 关键约束：
 * - proot 全套（libproot / loader / libtalloc / libandroid-shmem）以 `lib*.so`
 *   打进 jniLibs，安装后位于 nativeLibraryDir —— App 目录里唯一允许 execve 的位置。
 * - Termux 版 proot 的 loader 是分离的，必须用 PROOT_LOADER / PROOT_LOADER_32 指向。
 * - Android 没有 /tmp，PROOT_TMP_DIR 必须显式指定且目录预先存在。
 */
class ContainerManager private constructor(private val ctx: Context) {

    companion object {
        private const val TAG = "W2AContainer"

        @Volatile private var instance: ContainerManager? = null
        fun get(ctx: Context): ContainerManager =
            instance ?: synchronized(this) {
                instance ?: ContainerManager(ctx.applicationContext).also { instance = it }
            }
    }

    @Volatile private var process: Process? = null
    private val lock = Any()

    fun isReady(): Boolean =
        Paths.proot(ctx).exists() && Paths.loader(ctx).exists()

    fun isRunning(): Boolean = process?.isAlive == true

    private fun buildEnv(rootfs: File): Map<String, String> = buildMap {
        put("PROOT_TMP_DIR", File(rootfs, "tmp").apply { mkdirs() }.absolutePath)
        put("PROOT_LOADER", Paths.loader(ctx).absolutePath)
        put("PROOT_LOADER_32", Paths.loader32(ctx).absolutePath)
        put("LD_LIBRARY_PATH", "${Paths.nativeDir(ctx).absolutePath}:/system/lib64:/system/lib")
        put("HOME", "/root")
        put("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        put("LANG", "C.UTF-8")
        put("TERM", "dumb")
    }

    private fun buildArgv(rootfs: File, program: String, args: List<String>): List<String> {
        val argv = mutableListOf(
            Paths.proot(ctx).absolutePath,
            "-r", rootfs.absolutePath,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "/system",
        )
        // bionic 二进制（如 Termux 版工具）需要 /apex 里的 linker；Android 9 及以下没有。
        if (File("/apex").isDirectory) {
            argv += listOf("-b", "/apex")
        }
        // 伪 root：apt / 包管理需要。
        argv += "-0"
        argv += listOf("-w", "/root")
        // Android app 私有目录禁止硬链接（untrusted_app 域），proot 需要该选项
        // 把硬链接降级为符号链接，否则 exec/解包会失败。
        argv += "--link2symlink"
        argv += program
        argv += args
        return argv
    }

    /** 同步执行一条容器命令并收集输出（用于 provisioning）。 */
    fun runBlocking(
        program: String,
        args: List<String>,
        timeoutSec: Long = 600,
        onLine: (String) -> Unit = {},
    ): Int {
        val rootfs = Paths.rootfs(ctx)
        val argv = buildArgv(rootfs, program, args)
        val pb = ProcessBuilder(argv).apply {
            redirectErrorStream(true)
            environment().apply {
                remove("LD_PRELOAD")
                putAll(buildEnv(rootfs))
            }
        }
        val proc = pb.start()
        val reader = Thread {
            runCatching {
                proc.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { onLine(it) }
                }
            }
        }.apply { isDaemon = true; start() }
        val finished = proc.waitFor(timeoutSec, TimeUnit.SECONDS)
        if (!finished) {
            proc.destroyForcibly()
            reader.interrupt()
            return -1
        }
        reader.join(2000)
        return proc.exitValue()
    }

    /** 启动长期运行的容器进程（Node 控制面）。 */
    fun start(
        program: String,
        args: List<String>,
        onOutput: (String) -> Unit,
    ): Boolean = synchronized(lock) {
        if (isRunning()) return true
        val rootfs = Paths.rootfs(ctx)
        if (!isReady()) {
            onOutput("proot 缺失（检查 jniLibs / useLegacyPackaging）\n")
            return false
        }
        val argv = buildArgv(rootfs, program, args)
        val proc = runCatching {
            ProcessBuilder(argv).apply {
                redirectErrorStream(true)
                environment().apply {
                    remove("LD_PRELOAD")
                    putAll(buildEnv(rootfs))
                }
            }.start()
        }.getOrElse { e ->
            onOutput("容器启动失败: ${e.message}\n")
            return false
        }
        process = proc
        Thread {
            runCatching {
                proc.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { onOutput(it + "\n") }
                }
            }
        }.apply { isDaemon = true; start() }
        // proot 环境不对会立即退出，需靠存活检查区分成败。
        Thread.sleep(500)
        if (!proc.isAlive) {
            Log.e(TAG, "container exited immediately: ${runCatching { proc.exitValue() }.getOrDefault(-1)}")
            process = null
            return false
        }
        Log.i(TAG, "container started: ${rootfs.name}")
        true
    }

    fun stop() {
        synchronized(lock) {
            val p = process ?: return
            process = null
            runCatching { p.destroy() }
            runCatching {
                if (!p.waitFor(3, TimeUnit.SECONDS)) p.destroyForcibly()
            }
        }
    }
}
