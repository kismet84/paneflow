package com.codexpane.companion;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionUrlTest {
    @Test public void acceptsSecureAndUsbPairing() {
        assertEquals("https://pane.example.com/relay/#pair=abc_123", ConnectionUrl.validate("https://pane.example.com/relay/#pair=abc_123"));
        assertEquals("http://localhost:48321/", ConnectionUrl.validate("http://localhost:48321/"));
    }
    @Test public void rejectsUnsafeOrMalformedInput() {
        for (String input : new String[] {"javascript:alert(1)", "file:///x", "http://192.168.1.2/", "https://user:pass@example.com/", "https://example.com/?token=x", "https://example.com/#pair=x&other=y", "https://example.com/a%2fb", "https://example.com:99999/", "https://exa\nmple.com/"}) {
            try { ConnectionUrl.validate(input); fail("Accepted invalid input"); }
            catch (IllegalArgumentException expected) { }
        }
    }
}
