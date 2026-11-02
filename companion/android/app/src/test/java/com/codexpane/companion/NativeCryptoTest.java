package com.codexpane.companion;

import java.util.*;
import java.security.*;
import java.security.spec.PKCS8EncodedKeySpec;
import javax.crypto.AEADBadTagException;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeCryptoTest {
    private Properties vector() throws Exception {
        Properties values = new Properties();
        try (java.io.InputStream input = getClass().getResourceAsStream("/crypto-vector.properties")) { values.load(input); }
        return values;
    }
    @Test public void interoperatesWithNodeP256HkdfAndAesGcm() throws Exception {
        Properties v = vector();
        PrivateKey local = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(NativeCrypto.unb64(v.getProperty("private"))));
        PublicKey remote = NativeCrypto.publicKey(v.getProperty("bx"), v.getProperty("by"));
        byte[] key = NativeCrypto.derive(local, remote, v.getProperty("context"));
        assertEquals(v.getProperty("key"), NativeCrypto.b64(key));
        assertTrue(NativeCrypto.verify(NativeCrypto.publicKey(v.getProperty("ax"),v.getProperty("ay")),v.getProperty("proof"),v.getProperty("signature")));
        byte[] expected = NativeCrypto.unb64(v.getProperty("ciphertext"));
        assertArrayEquals(expected, NativeCrypto.crypt(true, key, v.getProperty("session"), 0, NativeCrypto.unb64(v.getProperty("iv")), NativeCrypto.utf8("{\"type\":\"snapshot.get\"}")));
        assertArrayEquals(NativeCrypto.utf8("{\"type\":\"snapshot.get\"}"), NativeCrypto.crypt(false, key, v.getProperty("session"), 0, NativeCrypto.unb64(v.getProperty("iv")), expected));
    }
    @Test public void rejectsTamperingAndWrongSequence() throws Exception {
        Properties v = vector(); byte[] cipher = NativeCrypto.unb64(v.getProperty("ciphertext"));
        try { NativeCrypto.crypt(false, NativeCrypto.unb64(v.getProperty("key")),v.getProperty("session"),1,NativeCrypto.unb64(v.getProperty("iv")),cipher); fail(); } catch(AEADBadTagException expected) { }
        cipher[0] ^= 1;
        try { NativeCrypto.crypt(false, NativeCrypto.unb64(v.getProperty("key")),v.getProperty("session"),0,NativeCrypto.unb64(v.getProperty("iv")),cipher); fail(); } catch(AEADBadTagException expected) { }
        assertFalse(NativeCrypto.verify(NativeCrypto.publicKey(v.getProperty("ax"),v.getProperty("ay")),"wrong proof",v.getProperty("signature")));
    }
    @Test public void roundTripsP1363Signatures() throws Exception {
        for (int i=0;i<50;i++) {
            KeyPair pair=NativeCrypto.ephemeral(); String signature=NativeCrypto.sign(pair.getPrivate(),"hello");
            assertEquals(64, NativeCrypto.unb64(signature).length);
            assertTrue(NativeCrypto.verify(pair.getPublic(),"hello",signature));
        }
    }
}
