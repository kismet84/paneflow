package com.codexpane.companion;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.*;
import java.security.spec.ECGenParameterSpec;

final class NativeIdentity {
    static KeyPair signing(String deviceId) throws Exception {
        String alias = "pane-native-" + deviceId;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false).build());
            generator.generateKeyPair();
        }
        return new KeyPair(store.getCertificate(alias).getPublicKey(), (PrivateKey)store.getKey(alias, null));
    }
    static void remove(String deviceId) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry("pane-native-" + deviceId);
    }
    static KeyPair existing(String deviceId) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        String alias = "pane-native-" + deviceId;
        if (!store.containsAlias(alias)) throw new SecurityException("设备密钥不存在，请重新配对");
        return new KeyPair(store.getCertificate(alias).getPublicKey(), (PrivateKey)store.getKey(alias, null));
    }
}
