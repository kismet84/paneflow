package com.codexpane.companion;

import java.net.URI;
import java.net.URISyntaxException;

final class ConnectionUrl {
    static String validate(String value) {
        if (value == null || value.isEmpty() || value.length() > 16000 || value.matches("(?s).*[\\x00-\\x20\\x7f].*")) {
            throw new IllegalArgumentException("链接格式不正确。");
        }
        try {
            URI uri = new URI(value);
            boolean secure = "https".equals(uri.getScheme());
            boolean usb = "http".equals(uri.getScheme()) && ("localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()));
            if ((!secure && !usb) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getPort() > 65535) {
                throw new IllegalArgumentException("仅支持 HTTPS 或 USB localhost 地址，且不能包含凭据或查询参数。");
            }
            String path = uri.getRawPath();
            if (path == null || !path.matches("/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?/?")) {
                throw new IllegalArgumentException("中继路径格式不正确。");
            }
            String fragment = uri.getRawFragment();
            if (fragment != null && !fragment.matches("pair=[A-Za-z0-9_-]+")) {
                throw new IllegalArgumentException("配对信息格式不正确。");
            }
            return uri.toASCIIString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("链接格式不正确。");
        }
    }
}
