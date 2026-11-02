package com.codexpane.companion;

import android.content.ActivityNotFoundException;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ChromeSession")
public class ChromeSessionPlugin extends Plugin {
    private static final String CHROME = "com.android.chrome";

    @PluginMethod
    public void open(PluginCall call) {
        final String url;
        try {
            url = ConnectionUrl.validate(call.getString("url"));
            if (!getContext().getPackageManager().getApplicationInfo(CHROME, 0).enabled) {
                call.reject("Google Chrome 已停用，请启用后再连接。");
                return;
            }
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("未安装 Google Chrome。请安装 Chrome 后再连接；不会改用其他浏览器。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                CustomTabsIntent tab = new CustomTabsIntent.Builder()
                    .setDefaultColorSchemeParams(new CustomTabColorSchemeParams.Builder().setToolbarColor(Color.rgb(15, 118, 110)).build())
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build();
                tab.intent.setPackage(CHROME);
                tab.launchUrl(getActivity(), Uri.parse(url));
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException error) {
                call.reject("无法打开 Chrome，请确认已安装并启用最新版 Chrome。不会改用其他浏览器。");
            }
        });
    }
}
