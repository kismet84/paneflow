package com.codexpane.companion;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeCommandErrorsTest {
    @Test public void writerConflictExplainsOwnershipWithoutExposingRawThreadId() {
        String result = NativeCommandErrors.message("thread private-thread-id already has an active writer");
        assertTrue(result.contains("另一个 Codex 窗口"));
        assertTrue(result.contains("草稿不会删除"));
        assertFalse(result.contains("private-thread-id"));
    }
    @Test public void unrelatedErrorsKeepTheirMeaning() {
        assertEquals("网络中断", NativeCommandErrors.message("网络中断"));
        assertEquals("操作未完成，请重试", NativeCommandErrors.message(null));
    }
}
