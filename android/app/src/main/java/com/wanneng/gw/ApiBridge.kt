package com.wanneng.gw

import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * JS ↔ 原生 HTTP 桥。
 *
 * 为什么需要：Android WebView 会把 `http://127.0.0.1:17800` 也交给系统 HTTP 代理，
 * 设备开着代理时管理台直接 ERR_CONNECTION_REFUSED。这里由 App 进程直连容器内的
 * Manager API（显式 Proxy.NO_PROXY），页面侧用 ui/public/w2a-bridge.js 把 fetch
 * 接到本桥，完全绕开 WebView 的网络栈与代理。
 *
 * 安全边界：只允许访问固定的 127.0.0.1:17800，只接受以单个 `/` 开头的路径，
 * 不接受外部 URL、scheme 或 host。
 */
class ApiBridge(private val webView: WebView) {

    companion object {
        private const val TAG = "W2ABridge"
        private const val HOST = "127.0.0.1"
        private const val PORT = 17800
        private const val CONNECT_TIMEOUT_MS = 8000
        private const val READ_TIMEOUT_MS = 20000
    }

    @JavascriptInterface
    fun fetch(id: String, method: String, path: String, headersJson: String, body: String?) {
        // 桥调用发生在 WebView 的 JS 线程（阻塞 JS），这里必须立刻切到后台线程。
        Thread {
            val result = JSONObject()
            try {
                require(path.startsWith("/") && !path.startsWith("//")) { "非法路径: $path" }
                val conn = URL("http://$HOST:$PORT$path").openConnection(Proxy.NO_PROXY)
                    as HttpURLConnection
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout = READ_TIMEOUT_MS
                conn.instanceFollowRedirects = true
                conn.useCaches = false
                conn.requestMethod = method.uppercase()

                runCatching {
                    val h = JSONObject(headersJson.ifBlank { "{}" })
                    h.keys().forEach { k -> conn.setRequestProperty(k, h.optString(k)) }
                }.onFailure { Log.w(TAG, "headers 解析失败: ${it.message}") }

                if (body != null && conn.requestMethod !in setOf("GET", "HEAD")) {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }

                val status = conn.responseCode
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                result.put("status", status)
                result.put("body", text)
                result.put("contentType", conn.contentType ?: "")
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "$method $path 失败: ${e.message}")
                result.put("error", e.message ?: e.javaClass.simpleName)
            }
            notifyJs(id, result)
        }.apply { isDaemon = true }.start()
    }

    /**
     * 用系统浏览器打开 URL（网关自带面板等）。
     *
     * 容器里没有 xdg-open，server.js 的 openExternal 兜底是空操作；WebView 自己
     * 也无法处理 target=_blank / window.open，所以统一由 App 起 Intent。
     */
    @JavascriptInterface
    fun openExternal(url: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Log.w(TAG, "拒绝打开非 http(s) URL: $url")
            return
        }
        webView.post {
            runCatching {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                webView.context.startActivity(intent)
            }.onFailure { Log.w(TAG, "openExternal 失败: ${it.message}") }
        }
    }

    private fun notifyJs(id: String, result: JSONObject) {
        val js = "window.__w2aFetchDone && window.__w2aFetchDone(" +
            JSONObject.quote(id) + "," + result.toString() + ")"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}