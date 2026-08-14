package com.nxhub.android

import android.annotation.SuppressLint
import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.widget.ScrollView
import kotlin.math.max

/**
 * A ScrollView that reports an over-scroll drag at the top as "pull to refresh".
 *
 * androidx.SwipeRefreshLayout would be the obvious answer, but pulling in
 * androidx just for this widget is not worth ~200 KB; 40 lines of touch handling
 * does the same job. The Pico's laser-pointer drag produces ordinary touch
 * events, so this works in the headset as well as on a phone. A Refresh button
 * sits in the header too, for anyone who does not like dragging in VR.
 */
class PullRefreshScrollView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : ScrollView(context, attrs, defStyle) {

    var onRefresh: (() -> Unit)? = null
    var onPullProgress: ((Float) -> Unit)? = null
    var enabledPull: Boolean = true

    private var startY = 0f
    private var pulling = false
    private val threshold = 120 * resources.displayMetrics.density

    // A scroll container has no click semantics to forward; the buttons inside
    // the rows are the accessible targets, and the header Refresh button is the
    // keyboard/accessibility route to this gesture.
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
        if (enabledPull) {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startY = ev.y
                    pulling = scrollY == 0
                }
                MotionEvent.ACTION_MOVE -> {
                    if (pulling && scrollY == 0) {
                        val dy = max(0f, ev.y - startY)
                        onPullProgress?.invoke((dy / threshold).coerceIn(0f, 1f))
                    } else {
                        startY = ev.y
                        pulling = scrollY == 0
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val dy = ev.y - startY
                    val fired = pulling && scrollY == 0 && dy > threshold &&
                        ev.actionMasked == MotionEvent.ACTION_UP
                    pulling = false
                    onPullProgress?.invoke(0f)
                    if (fired) onRefresh?.invoke()
                }
            }
        }
        return super.onTouchEvent(ev)
    }
}
