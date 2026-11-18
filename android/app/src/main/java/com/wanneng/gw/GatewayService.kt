package com.wanneng.gw

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * 前台服务：把 proot 容器（Node 控制面）提到前台，避免退后台被系统回收。
 *
 * 启动顺序：provision（rootfs/node/payload）→ 容器内执行 node shell/server.js
 * → 死了就按 3s 间隔重启（Node 壳自己再管各网关进程）。
 */
class GatewayService : Service() {

    companion object {
        private const val TAG = "W2AService"
        private const val CHANNEL_ID = "w2a_gateway"
        private const val NOTIFICATION_ID = 2001

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, GatewayService::class.java))
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var loopJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val container by lazy { ContainerManager.get(this) }
    private lateinit var provisioner: Provisioner

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundSafely("正在准备运行环境")
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (loopJob == null) loopJob = scope.launch { runLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        runCatching { scope.cancel() }
        runCatching { container.stop() }
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun runLoop() {
        provisioner = Provisioner(this)
        val ok = provisioner.provision()
        if (!ok) {
            updateNotification("运行环境准备失败，请打开 App 重试")
            return
        }
        val rootfs = Paths.rootfs(this)
        val node = Paths.nodeInside(rootfs) ?: run {
            updateNotification("未找到 node")
            return
        }
        // proot 接受的是容器内路径，不是宿主机绝对路径。
        val nodePath = Paths.containerPath(rootfs, node)
        val serverPath = "/opt/payload/shell/server.js"
        updateNotification("正在启动网关…")

        while (scope.isActive) {
            if (!container.isRunning()) {
                Log.i(TAG, "starting node: $nodePath $serverPath")
                val started = container.start(
                    nodePath,
                    listOf(serverPath),
                ) { line -> Log.i(TAG, "node> $line") }
                if (started) {
                    updateNotification("网关运行中 · 127.0.0.1:${Paths.PORT}")
                } else {
                    updateNotification("网关启动失败，3s 后重试")
                }
            }
            delay(3000)
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "w2a:gateway").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "网关服务", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
    }

    private fun startForegroundSafely(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val open = Intent(this, MainActivity::class.java)
        val pi = android.app.PendingIntent.getActivity(
            this, 0, open,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("万能网关")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }
}
