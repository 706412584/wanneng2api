package com.wanneng.gw

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机后拉起网关服务（受系统后台启动限制，部分 ROM 可能不生效）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            runCatching { GatewayService.start(context) }
        }
    }
}
