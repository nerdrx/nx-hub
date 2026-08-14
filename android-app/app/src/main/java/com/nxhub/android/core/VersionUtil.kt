package com.nxhub.android.core

/**
 * Tag → version normalisation and semver-ish comparison.
 *
 * Release tags in the NX family are inconsistent by design ("v1.2.3", "nx-1.3",
 * "wivrn-nx-v0.9", plain "1.0.0"), so normalisation is "drop everything before
 * the first digit as long as it is only letters, dashes, dots and underscores".
 */
object VersionUtil {

    /** Strip a leading textual prefix from a tag: v1.2.3 → 1.2.3, nx-1.3 → 1.3. */
    fun normalize(tag: String?): String {
        val t = (tag ?: "").trim()
        if (t.isEmpty()) return ""
        val firstDigit = t.indexOfFirst { it.isDigit() }
        // No digits at all, or already starts with one → nothing to strip.
        if (firstDigit <= 0) return t
        val prefix = t.substring(0, firstDigit)
        // Only strip a prefix that looks like a name/marker, never digits-adjacent junk.
        return if (prefix.all { it.isLetter() || it == '-' || it == '_' || it == '.' || it == '/' }) {
            t.substring(firstDigit)
        } else {
            t
        }
    }

    /**
     * Compare two version strings. Returns <0, 0 or >0 like Comparator.
     * Numeric segments compare numerically, a release outranks its pre-releases
     * (1.2.0 > 1.2.0-beta1), and missing trailing segments count as 0 (1.2 == 1.2.0).
     */
    fun compare(a: String?, b: String?): Int {
        val (mainA, preA) = split(normalize(a))
        val (mainB, preB) = split(normalize(b))

        val na = mainA.split('.', '-', '_', '+')
        val nb = mainB.split('.', '-', '_', '+')
        val n = maxOf(na.size, nb.size)
        for (i in 0 until n) {
            val c = compareSegment(na.getOrElse(i) { "0" }, nb.getOrElse(i) { "0" })
            if (c != 0) return c
        }

        // Equal main version: no pre-release wins over a pre-release.
        if (preA.isEmpty() && preB.isEmpty()) return 0
        if (preA.isEmpty()) return 1
        if (preB.isEmpty()) return -1

        val pa = preA.split('.', '-')
        val pb = preB.split('.', '-')
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val c = compareSegment(pa.getOrElse(i) { "" }, pb.getOrElse(i) { "" })
            if (c != 0) return c
        }
        return 0
    }

    /** true when [latest] is strictly newer than [installed]. */
    fun isNewer(latest: String?, installed: String?): Boolean {
        if (installed.isNullOrBlank()) return false
        return compare(latest, installed) > 0
    }

    private fun split(v: String): Pair<String, String> {
        // Everything after the first '-' that is followed by a non-digit is a
        // pre-release marker: 1.2.0-beta1 → ("1.2.0", "beta1"); 1.2-3 stays numeric.
        for (i in v.indices) {
            if (v[i] == '-' && i + 1 < v.length && !v[i + 1].isDigit()) {
                return v.substring(0, i) to v.substring(i + 1)
            }
        }
        val plus = v.indexOf('+')
        if (plus >= 0) return v.substring(0, plus) to ""
        return v to ""
    }

    private fun compareSegment(a: String, b: String): Int {
        val ia = a.toIntOrNull()
        val ib = b.toIntOrNull()
        return when {
            ia != null && ib != null -> ia.compareTo(ib)
            ia != null -> 1            // numeric identifier > alphanumeric one
            ib != null -> -1
            else -> a.compareTo(b)
        }
    }
}
