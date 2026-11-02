package com.codexpane.companion;

import java.util.Locale;

final class NativeCommandErrors {
    private NativeCommandErrors() {}

    static String message(String detail) {
        if (detail == null || detail.trim().isEmpty()) return "操作未完成，请重试";
        if (detail.toLowerCase(Locale.ROOT).contains("already has an active writer")) {
            return "该会话正由电脑上的另一个 Codex 窗口使用，暂时无法在手机接管。\n\n请在原窗口完成当前操作并关闭该会话后，再从手机会话列表重新打开；也可以新建会话。现有聊天和草稿不会删除。";
        }
        return detail;
    }
}
