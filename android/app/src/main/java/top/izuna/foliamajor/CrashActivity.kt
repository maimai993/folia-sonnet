package top.izuna.foliamajor
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

import androidx.appcompat.app.AppCompatActivity

/**
 * 崩溃界面：把 FoliaCrashHandler 抓到的栈直接显示出来。
 *
 * 用代码搭界面而不是 XML，是因为它只是个取证用的临时页，越少牵扯资源越好。
 */
class CrashActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_TRACE = "trace"
        const val EXTRA_SAVED_PATH = "savedPath"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val trace = safeExtra(EXTRA_TRACE, "(没有拿到栈)")
        val savedPath = safeExtra(EXTRA_SAVED_PATH, "")

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.parseColor("#09090b"))
        val pad = dp(18)
        root.setPadding(pad, dp(40), pad, pad)

        val title = TextView(this)
        title.text = "Folia 崩溃了"
        title.setTextColor(Color.parseColor("#f87171"))
        title.setTextSize(20f)
        title.setTypeface(null, Typeface.BOLD)
        root.addView(title, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        /*
         * 换行后以 `+` 开头的那句：这是 Kotlin 2.3 的解析收紧。
         *
         * 老编译器把它读成「上一行的字符串 + 下一行」，2.3 起会读成一元 `+`（因为
         * `text` 的类型是 CharSequence，两边都可能是一元的），于是报
         * `Unresolved reference 'unaryPlus'`。把 `+` 收进上一行，意图就唯一了。
         */
        val hint = TextView(this)
        hint.text = "把下面这段发给开发者。日志同时已保存到：\n" +
                (if (savedPath.isEmpty()) "(保存失败)" else savedPath)
        hint.setTextColor(Color.parseColor("#9ca3af"))
        hint.setTextSize(12f)
        hint.setPadding(0, dp(8), 0, dp(12))
        root.addView(hint, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val traceView = TextView(this)
        traceView.text = trace
        traceView.setTextColor(Color.parseColor("#e5e7eb"))
        traceView.setTextSize(11f)
        traceView.typeface = Typeface.MONOSPACE
        traceView.setTextIsSelectable(true)

        val scroller = ScrollView(this)
        scroller.addView(traceView)
        val scrollParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        scrollParams.bottomMargin = dp(12)
        root.addView(scroller, scrollParams)

        val copy = makeButton("复制崩溃日志")
        copy.setOnClickListener(object : View.OnClickListener {
            override fun onClick(view: View) {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText("folia-crash", trace))
                    Toast.makeText(this@CrashActivity, "已复制", Toast.LENGTH_SHORT).show()
                }
            }
        })
        root.addView(copy)

        val restart = makeButton("重启应用")
        restart.setOnClickListener(object : View.OnClickListener {
            override fun onClick(view: View) {
                val launch = packageManager.getLaunchIntentForPackage(packageName)
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    startActivity(launch)
                }
                finish()
            }
        })
        root.addView(restart)

        setContentView(root)
    }

    private fun makeButton(text: String): Button {
        val button = Button(this)
        button.text = text
        button.isAllCaps = false
        val params = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        params.topMargin = dp(6)
        button.layoutParams = params
        return button
    }

    private fun safeExtra(key: String, fallback: String): String {
        val value = intent.getStringExtra(key)
        return value ?: fallback
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }
}
