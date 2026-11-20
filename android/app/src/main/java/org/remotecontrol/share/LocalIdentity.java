package org.remotecontrol.share;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Date;
import java.util.Locale;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.security.auth.x500.X500Principal;

final class LocalIdentity extends X509ExtendedKeyManager {
    private static final String ALIAS = "local-screen-certificate-v1";
    private final PrivateKey key;
    private final X509Certificate certificate;

    LocalIdentity() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            long now = System.currentTimeMillis();
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setCertificateSubject(new X500Principal("CN=Remote Screen"))
                    .setCertificateSerialNumber(new BigInteger(120, new SecureRandom()).add(BigInteger.ONE))
                    .setCertificateNotBefore(new Date(now - 86_400_000L))
                    .setCertificateNotAfter(new Date(now + 10L * 365 * 86_400_000L)).build());
            generator.generateKeyPair();
        }
        key = (PrivateKey) store.getKey(ALIAS, null);
        certificate = (X509Certificate) store.getCertificate(ALIAS);
    }

    SSLContext context() throws Exception {
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(new KeyManager[]{this}, null, null);
        return tls;
    }

    String fingerprint() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder display = new StringBuilder();
        for (byte octet : digest) {
            if (display.length() > 0) display.append(':');
            display.append(String.format(Locale.ROOT, "%02X", octet));
        }
        return display.toString();
    }

    @Override public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
        return "EC".equals(type) ? ALIAS : null;
    }
    @Override public String chooseEngineServerAlias(String type, Principal[] issuers, javax.net.ssl.SSLEngine engine) {
        return chooseServerAlias(type, issuers, null);
    }
    @Override public String[] getServerAliases(String type, Principal[] issuers) {
        return "EC".equals(type) ? new String[]{ALIAS} : null;
    }
    @Override public X509Certificate[] getCertificateChain(String alias) {
        return ALIAS.equals(alias) ? new X509Certificate[]{certificate} : null;
    }
    @Override public PrivateKey getPrivateKey(String alias) { return ALIAS.equals(alias) ? key : null; }
    @Override public String[] getClientAliases(String type, Principal[] issuers) { return null; }
    @Override public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) { return null; }
}
