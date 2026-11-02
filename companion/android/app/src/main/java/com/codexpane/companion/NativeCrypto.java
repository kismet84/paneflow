package com.codexpane.companion;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Wire compatibility with Codex Pane: P-256 IEEE-P1363 signatures, HKDF and AES-GCM. */
final class NativeCrypto {
    static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    static String b64(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    static byte[] unb64(String value) { return Base64.getUrlDecoder().decode(value); }
    static KeyPair ephemeral() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }
    static byte[] fixed(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] result = new byte[32];
        System.arraycopy(raw, Math.max(0, raw.length - 32), result, Math.max(0, 32 - raw.length), Math.min(32, raw.length));
        return result;
    }
    static String x(PublicKey key) { return b64(fixed(((ECPublicKey) key).getW().getAffineX())); }
    static String y(PublicKey key) { return b64(fixed(((ECPublicKey) key).getW().getAffineY())); }
    static String canonical(String x, String y) {
        if (!x.matches("[A-Za-z0-9_-]{43}") || !y.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Invalid P-256 point");
        return "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"" + x + "\",\"y\":\"" + y + "\"}";
    }
    static PublicKey publicKey(String x, String y) throws Exception {
        canonical(x, y);
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(new BigInteger(1, unb64(x)), new BigInteger(1, unb64(y))), parameters.getParameterSpec(ECParameterSpec.class)));
    }
    static byte[] derive(PrivateKey local, PublicKey remote, String context) throws Exception {
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(local);
        agreement.doPhase(remote, true);
        return hkdf(agreement.generateSecret(), utf8(context), utf8("codex-pane-remote-v1"));
    }
    static byte[] hkdf(byte[] shared, byte[] salt, byte[] info) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(shared);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info);
        return mac.doFinal(new byte[]{1});
    }
    static String sign(PrivateKey key, String proof) throws Exception {
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(key);
        signature.update(utf8(proof));
        return b64(derToRaw(signature.sign()));
    }
    static boolean verify(PublicKey key, String proof, String raw) throws Exception {
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initVerify(key);
        signature.update(utf8(proof));
        return signature.verify(rawToDer(unb64(raw)));
    }
    static byte[] derToRaw(byte[] der) {
        if (der.length < 8 || der[0] != 0x30 || (der[1] & 255) != der.length - 2 || der[2] != 2) throw new IllegalArgumentException("Invalid DER");
        int rLength = der[3] & 255;
        int second = 4 + rLength;
        if (rLength < 1 || rLength > 33 || second + 2 >= der.length || der[second] != 2) throw new IllegalArgumentException("Invalid DER");
        int sLength = der[second + 1] & 255;
        if (sLength < 1 || sLength > 33 || second + 2 + sLength != der.length) throw new IllegalArgumentException("Invalid DER");
        byte[] result = new byte[64];
        System.arraycopy(fixed(new BigInteger(Arrays.copyOfRange(der, 4, second))), 0, result, 0, 32);
        System.arraycopy(fixed(new BigInteger(Arrays.copyOfRange(der, second + 2, der.length))), 0, result, 32, 32);
        return result;
    }
    static byte[] rawToDer(byte[] raw) {
        if (raw.length != 64) throw new IllegalArgumentException("Invalid raw signature");
        byte[] r = new BigInteger(1, Arrays.copyOfRange(raw, 0, 32)).toByteArray();
        byte[] s = new BigInteger(1, Arrays.copyOfRange(raw, 32, 64)).toByteArray();
        byte[] result = new byte[6 + r.length + s.length];
        result[0] = 0x30; result[1] = (byte)(result.length - 2); result[2] = 2; result[3] = (byte)r.length;
        System.arraycopy(r, 0, result, 4, r.length);
        result[4 + r.length] = 2; result[5 + r.length] = (byte)s.length;
        System.arraycopy(s, 0, result, 6 + r.length, s.length);
        return result;
    }
    static byte[] crypt(boolean encrypt, byte[] key, String session, long sequence, byte[] iv, byte[] value) throws Exception {
        if (iv.length != 12) throw new IllegalArgumentException("Invalid IV");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(utf8("codex-pane-secure-v1\n" + session + "\n" + sequence));
        return cipher.doFinal(value);
    }
}
