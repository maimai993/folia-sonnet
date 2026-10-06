package top.izuna.foliamajor;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * 崩溃界面：把 FoliaCrashHandler 抓到的栈直接显示出来。
 *
 * 用代码搭界面而不是 XML，是因为它只是个取证用的临时页，越少牵扯资源越好。
 */
public class CrashActivity extends AppCompatActivity {

    static final String EXTRA_TRACE = "trace";
    static final String EXTRA_SAVED_PATH = "savedPath";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final String trace = safeExtra(EXTRA_TRACE, "(没有拿到栈)");
        final String savedPath = safeExtra(EXTRA_SAVED_PATH, "");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#09090b"));
        int pad = dp(18);
        root.setPadding(pad, dp(40), pad, pad);

        TextView title = new TextView(this);
        title.setText("Folia 崩溃了");
        title.setTextColor(Color.parseColor("#f87171"));
        title.setTextSize(20f);
        title.setTypeface(null, Typeface.BOLD);
        root.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setText("把下面这段发给开发者。日志同时已保存到：\n"
                + (savedPath.isEmpty() ? "(保存失败)" : savedPath));
        hint.setTextColor(Color.parseColor("#9ca3af"));
        hint.setTextSize(12f);
        hint.setPadding(0, dp(8), 0, dp(12));
        root.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView traceView = new TextView(this);
        traceView.setText(trace);
        traceView.setTextColor(Color.parseColor("#e5e7eb"));
        traceView.setTextSize(11f);
        traceView.setTypeface(Typeface.MONOSPACE);
        traceView.setTextIsSelectable(true);

        ScrollView scroller = new ScrollView(this);
        scroller.addView(traceView);
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        scrollParams.bottomMargin = dp(12);
        root.addView(scroller, scrollParams);

        Button copy = makeButton("复制崩溃日志");
        copy.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                ClipboardManager clipboard =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText("folia-crash", trace));
                    Toast.makeText(CrashActivity.this, "已复制", Toast.LENGTH_SHORT).show();
                }
            }
        });
        root.addView(copy);

        Button restart = makeButton("重启应用");
        restart.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    startActivity(launch);
                }
                finish();
            }
        });
        root.addView(restart);

        setContentView(root);
    }

    private Button makeButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(6);
        button.setLayoutParams(params);
        return button;
    }

    private String safeExtra(String key, String fallback) {
        String value = getIntent().getStringExtra(key);
        return value == null ? fallback : value;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }
}
