package com.nxhub.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256/GCM encryption of the GitHub token using a key that never leaves the
 * AndroidKeyStore (hardware-backed on the Pico 4 and on any modern phone).
 *
 * Stored form is "1:<base64 iv>:<base64 ciphertext>". If the keystore is
 * unavailable for any reason we fall back to storing the token as plain text
 * prefixed with "0:" — the file still lives in the app-private data dir, which is
 * unreadable by other apps on a non-rooted device.
 */
class TokenCrypto(private val context: Context) {

    fun encrypt(plain: String): String {
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            "1:" + b64(cipher.iv) + ":" + b64(ct)
        } catch (e: Exception) {
            Log.w(TAG, "keystore unavailable, storing token unencrypted in private prefs", e)
            "0:" + b64(plain.toByteArray(Charsets.UTF_8))
        }
    }

    fun decrypt(stored: String): String? {
        return try {
            val parts = stored.split(':')
            when {
                parts.size == 3 && parts[0] == "1" -> {
                    val cipher = Cipher.getInstance(TRANSFORM)
                    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(parts[1])))
                    String(cipher.doFinal(unb64(parts[2])), Charsets.UTF_8)
                }
                parts.size == 2 && parts[0] == "0" -> String(unb64(parts[1]), Charsets.UTF_8)
                else -> stored // legacy plain value
            }
        } catch (e: Exception) {
            Log.w(TAG, "token could not be decrypted; clear and re-enter it", e)
            null
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)

    companion object {
        private const val TAG = "NXHub/TokenCrypto"
        private const val ALIAS = "nxhub_token_key"
        private const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
