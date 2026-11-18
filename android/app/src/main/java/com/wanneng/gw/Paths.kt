package com.wanneng.gw

import android.content.Context
import java.io.File

/** 运行期固定路径。rootfs 放私有目录（含符号链接/硬链接，不能放外部存储）。 */
object Paths {
    const val PORT = 17800

    fun rootfs(ctx: Context): File = File(ctx.filesDir, "linux").apply { mkdirs() }
    fun nativeDir(ctx: Context): File = File(ctx.applicationInfo.nativeLibraryDir)
    fun proot(ctx: Context): File = File(nativeDir(ctx), "libproot.so")
    fun loader(ctx: Context): File = File(nativeDir(ctx), "libproot-loader.so")
    fun loader32(ctx: Context): File = File(nativeDir(ctx), "libproot-loader32.so")

    /** 容器内 payload 就绪标记（相对 rootfs） */
    fun payloadInside(rootfs: File): File = File(rootfs, "opt/payload")

    /** 容器内 node 可执行文件（优先下载的 usr/local，其次 apt 的 usr/bin） */
    fun nodeInside(rootfs: File): File? {
        val candidates = listOf(
            File(rootfs, "usr/local/bin/node"),
            File(rootfs, "usr/bin/node"),
        )
        return candidates.firstOrNull { it.exists() }
    }

    /**
     * 把 rootfs 内的宿主路径换算成 proot 可用的**容器内路径**（如 /usr/local/bin/node）。
     * proot 把程序路径当作 rootfs 内路径解析，传宿主绝对路径会报 not found。
     */
    fun containerPath(rootfs: File, f: File): String {
        val p = f.absolutePath
        return if (p.startsWith(rootfs.absolutePath)) p.removePrefix(rootfs.absolutePath) else p
    }
}
