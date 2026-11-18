package com.wanneng.gw

import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * 薄壳：WebView 加载 Node 控制台（127.0.0.1:17800），服务由 GatewayService 拉起。
 * 首次启动需要下载 rootfs / Node，先显示状态文字，就绪后切到 WebView。
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "W2AMain"
        private const val BASE = "http://127.0.0.1:17800"
    }

    private lateinit var webView: WebView
    private lateinit var status: TextView
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var loaded = false
    private var pollJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        maybeRequestNotificationPermission()
        runCatching { GatewayService.start(this) }
        startPolling()
    }

    private fun buildUi() {
        val root = FrameLayout(this)
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.loadsImagesAutomatically = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(Color.WHITE)
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
            // 接口调用走原生桥（强制 NO_PROXY），不受系统代理影响。
            addJavascriptInterface(ApiBridge(this), "W2ABridge")
            webViewClient = object : WebViewClient() {
                /**
                 * 静态资源由 App 直接从 APK 资产返回，避免 WebView 网络栈把
                 * http://127.0.0.1:17800 交给系统代理导致 ERR_CONNECTION_REFUSED。
                 * /api、/v1 等接口路径不拦截（由 w2a-bridge.js 转原生桥）。
                 */
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    val uri = request.url ?: return null
                    if (uri.host != "127.0.0.1" || uri.port != 17800) return null
                    val path = uri.path ?: return null
                    if (path.startsWith("/api/") || path.startsWith("/v1/")) return null

                    val assetPath = if (path == "/" || path.isEmpty()) {
                        "ui/dist/index.html"
                    } else {
                        "ui/dist" + path
                    }
                    return try {
                        val input = assets.open(assetPath)
                        val mime = mimeOf(assetPath)
                        if (mime.startsWith("text/") || mime.contains("json") ||
                            mime.contains("javascript")
                        ) {
                            WebResourceResponse(mime, "utf-8", input)
                        } else {
                            WebResourceResponse(mime, null, input)
                        }
                    } catch (e: Exception) {
                        // 未知路径回退 index.html（HashRouter 不需要，但保持容错）
                        if (path.startsWith("/assets/")) return null
                        runCatching {
                            WebResourceResponse(
                                "text/html", "utf-8",
                                assets.open("ui/dist/index.html"),
                            )
                        }.getOrNull()
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    status.visibility = android.view.View.GONE
                }
            }
        }
        status = TextView(this).apply {
            text = "正在启动网关…\n首次启动需要下载运行环境，请保持网络连接"
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setTextColor(Color.DKGRAY)
        }
        root.addView(webView)
        root.addView(
            status,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive && !loaded) {
                val ok = withContextIo { probe() }
                if (ok) {
                    loaded = true
                    webView.loadUrl("$BASE/")
                    break
                }
                delay(1500)
            }
        }
    }

    private suspend fun <T> withContextIo(block: () -> T): T =
        kotlinx.coroutines.withContext(Dispatchers.IO) { block() }

    private fun probe(): Boolean {
        return runCatching {
            // 显式 NO_PROXY：设备开着系统代理时 loopback 也不能交给代理。
            val c = URL("$BASE/api/overview").openConnection(Proxy.NO_PROXY)
                as HttpURLConnection
            c.connectTimeout = 1500
            c.readTimeout = 1500
            c.requestMethod = "GET"
            val code = c.responseCode
            c.disconnect()
            code in 200..399
        }.getOrDefault(false)
    }

    private fun mimeOf(name: String): String = when {
        name.endsWith(".html") -> "text/html"
        name.endsWith(".js") -> "application/javascript"
        name.endsWith(".css") -> "text/css"
        name.endsWith(".json") -> "application/json"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".png") -> "image/png"
        name.endsWith(".ico") -> "image/x-icon"
        name.endsWith(".woff2") -> "font/woff2"
        name.endsWith(".woff") -> "font/woff"
        else -> "application/octet-stream"
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            runCatching {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            }
        }
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (loaded && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        runCatching { pollJob?.cancel() }
        runCatching { scope.cancel() }
        runCatching { webView.destroy() }
        super.onDestroy()
    }
}
