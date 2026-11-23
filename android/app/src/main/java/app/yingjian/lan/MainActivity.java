package app.yingjian.lan;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.InputFilter;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int CAMERA_PERMISSION = 12, SCAN_REQUEST = 13;
    private static final int INK = 0xff111516, MUTED = 0xff778181, MINT = 0xff7cf3cd, BG = 0xfff2f4f4;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private SharedPreferences preferences;
    private FrameLayout root;
    private WebView web;
    private LinearLayout browser;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private EditText addressInput;
    private EditText codeInput;
    private TextView message;
    private Button connectButton;
    private String origin = "";
    private boolean connecting;
    private int connectionGeneration;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("server", MODE_PRIVATE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (BuildConfig.TV_MODE) getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        showSetup("");
        String remembered = preferences.getString("origin", "");
        if (!remembered.isEmpty()) connect(remembered, false);
    }

    private void showSetup(String notice) {
        connectionGeneration++;
        connecting = false;
        closeFullscreen();
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xfff5f6f6, 0xffedf1f0}));
        setContentView(root);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        int screenWidth = Math.round(getResources().getDisplayMetrics().widthPixels / getResources().getDisplayMetrics().density);
        boolean wideSetup = BuildConfig.TV_MODE && screenWidth >= 760;
        LinearLayout page = new LinearLayout(this); page.setOrientation(wideSetup ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL); page.setGravity(Gravity.CENTER);
        page.setPadding(dp(BuildConfig.TV_MODE ? 48 : 24), dp(BuildConfig.TV_MODE ? 20 : 32), dp(BuildConfig.TV_MODE ? 48 : 24), dp(BuildConfig.TV_MODE ? 20 : 32));
        scroll.addView(page, new ScrollView.LayoutParams(-1, -1));
        LinearLayout column = new LinearLayout(this); column.setOrientation(LinearLayout.VERTICAL);
        int introWidth = Math.min(280, Math.round((screenWidth - 120) * .4f));
        page.addView(column, new LinearLayout.LayoutParams(wideSetup ? dp(introWidth) : -1, -2));
        TextView brand = label("▶  映间" + (BuildConfig.TV_MODE ? " TV" : ""), 23, INK, true);
        brand.setPadding(0, 0, 0, dp(34)); column.addView(brand);
        TextView eyebrow = label("家庭影院 · 局域网版", 12, MUTED, false); column.addView(eyebrow);
        TextView title = label("连接你的服务端", BuildConfig.TV_MODE ? 30 : 29, INK, true);
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(-1, -2); titleLayout.setMargins(0, dp(9), 0, dp(10)); column.addView(title, titleLayout);
        TextView intro = label("手机、电视和电脑连接同一家庭网络。\n在电脑或 NAS 的“连接设备”中获取地址和连接码。", 14, MUTED, false);
        intro.setLineSpacing(dp(5), 1); column.addView(intro);
        LinearLayout card = new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(22), dp(24), dp(22), dp(22)); card.setBackground(round(Color.WHITE, 24));
        LinearLayout.LayoutParams cardLayout = new LinearLayout.LayoutParams(wideSetup ? dp(Math.min(440, screenWidth - 120 - introWidth)) : -1, -2);
        cardLayout.setMargins(wideSetup ? dp(24) : 0, wideSetup ? 0 : dp(26), 0, 0); (wideSetup ? page : column).addView(card, cardLayout);
        if (!BuildConfig.TV_MODE) {
            Button scan = button("扫描二维码连接", true); scan.setOnClickListener(v -> requestScan()); card.addView(scan, new LinearLayout.LayoutParams(-1, dp(54)));
            TextView divider = label("或使用服务端链接", 12, MUTED, false); divider.setGravity(Gravity.CENTER); divider.setPadding(0, dp(20), 0, dp(18)); card.addView(divider);
        }
        card.addView(label("服务端地址", 14, INK, true));
        addressInput = new EditText(this); addressInput.setSingleLine(true); addressInput.setTextSize(15); addressInput.setTextColor(INK); addressInput.setHintTextColor(MUTED);
        addressInput.setId(View.generateViewId()); addressInput.setHint("192.168.1.100:8080"); addressInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); addressInput.setSelectAllOnFocus(true);
        addressInput.setImeOptions(EditorInfo.IME_ACTION_NEXT | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        addressInput.setPadding(dp(16), dp(12), dp(16), dp(12)); addressInput.setBackground(round(BG, 14)); addressInput.setText(preferences.getString("origin", ""));
        LinearLayout.LayoutParams inputLayout = new LinearLayout.LayoutParams(-1, dp(54)); inputLayout.setMargins(0, dp(10), 0, dp(18)); card.addView(addressInput, inputLayout);
        card.addView(label("6 位连接码", 14, INK, true));
        codeInput = new EditText(this); codeInput.setId(View.generateViewId()); codeInput.setSingleLine(true); codeInput.setTextSize(20); codeInput.setTextColor(INK); codeInput.setHintTextColor(MUTED);
        codeInput.setHint("输入 6 位数字"); codeInput.setInputType(InputType.TYPE_CLASS_NUMBER); codeInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
        codeInput.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI); codeInput.setSaveEnabled(false);
        codeInput.setPadding(dp(16), dp(12), dp(16), dp(12)); codeInput.setBackground(round(BG, 14));
        LinearLayout.LayoutParams codeLayout = new LinearLayout.LayoutParams(-1, dp(54)); codeLayout.setMargins(0, dp(10), 0, dp(18)); card.addView(codeInput, codeLayout);
        connectButton = button("连接服务端", false); connectButton.setId(View.generateViewId()); connectButton.setOnClickListener(v -> connect(addressInput.getText().toString(), false)); card.addView(connectButton, new LinearLayout.LayoutParams(-1, dp(52)));
        addressInput.setNextFocusDownId(codeInput.getId()); addressInput.setNextFocusForwardId(codeInput.getId()); codeInput.setNextFocusUpId(addressInput.getId()); codeInput.setNextFocusDownId(connectButton.getId()); codeInput.setNextFocusForwardId(connectButton.getId()); connectButton.setNextFocusUpId(codeInput.getId());
        addressInput.setOnEditorActionListener((v, action, event) -> { if (action == EditorInfo.IME_ACTION_NEXT) { codeInput.requestFocus(); return true; } return false; });
        codeInput.setOnEditorActionListener((v, action, event) -> { if (action == EditorInfo.IME_ACTION_DONE) { connectButton.performClick(); return true; } return false; });
        for (EditText field : new EditText[]{addressInput, codeInput}) field.setOnFocusChangeListener((v, focus) -> { if (BuildConfig.TV_MODE) v.setBackground(round(focus ? 0xffd9f9ee : BG, 14)); });
        message = label(notice.isEmpty() ? "地址可直接输入 IP:8080。已配对或粘贴完整配对链接时，连接码可留空。" : notice, 12, notice.isEmpty() ? MUTED : 0xffb54434, false);
        message.setLineSpacing(dp(4), 1); message.setPadding(0, dp(16), 0, 0); card.addView(message);
        TextView footer = label("仅连接家庭局域网  ·  配对信息保存在此设备", 11, MUTED, false); footer.setGravity(Gravity.CENTER); footer.setPadding(0, dp(24), 0, 0); column.addView(footer);
        if (BuildConfig.TV_MODE) addressInput.requestFocus(); else column.setFocusableInTouchMode(true);
    }

    private void connect(String value, boolean qr) {
        if (connecting) return;
        final ServerAddress address;
        final String pairCode;
        try { address = ServerAddress.parse(value, qr); pairCode = address.pairToken.isEmpty() ? ServerAddress.pairingCode(codeInput.getText().toString()) : ""; } catch (IllegalArgumentException e) { message.setText(e.getMessage()); return; }
        final String savedCookie = CookieManager.getInstance().getCookie(address.origin);
        InputMethodManager keyboard = (InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(addressInput.getWindowToken(), 0);
        connecting = true; connectButton.setEnabled(false); connectButton.setText("正在连接…"); message.setText("正在检查局域网服务端");
        int generation = ++connectionGeneration;
        network.execute(() -> {
            String error = null;
            boolean alreadyPaired = false;
            List<String> responseCookies = new ArrayList<>();
            HttpURLConnection c = null;
            try {
                address.verifyLocalResolution();
                c = (HttpURLConnection)new URL(address.origin + "/api/status").openConnection();
                c.setConnectTimeout(6000); c.setReadTimeout(6000); c.setInstanceFollowRedirects(false);
                c.setRequestProperty("Cache-Control", "no-cache");
                if (savedCookie != null) c.setRequestProperty("Cookie", savedCookie);
                if (c.getResponseCode() != 200) throw new Exception("服务端返回 " + c.getResponseCode() + "，请检查地址和服务状态。");
                JSONObject status = readResponse(c.getInputStream());
                if (!status.has("paired") || !status.has("version")) throw new Exception("这不是映间局域网服务端。");
                alreadyPaired = status.optBoolean("paired", false);
                if (!pairCode.isEmpty()) {
                    c.disconnect();
                    address.verifyLocalResolution();
                    c = (HttpURLConnection)new URL(address.origin + "/api/pairing/claim").openConnection();
                    c.setConnectTimeout(6000); c.setReadTimeout(6000); c.setInstanceFollowRedirects(false); c.setRequestMethod("POST"); c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json; charset=utf-8"); c.setRequestProperty("X-Yingjian", "1"); c.setRequestProperty("Origin", address.origin);
                    JSONObject payload = new JSONObject().put("code", pairCode).put("kind", BuildConfig.TV_MODE ? "tv" : "phone").put("name", BuildConfig.TV_MODE ? "映间电视" : "映间手机");
                    byte[] body = payload.toString().getBytes("UTF-8"); c.setFixedLengthStreamingMode(body.length);
                    try (java.io.OutputStream output = c.getOutputStream()) { output.write(body); }
                    int code = c.getResponseCode();
                    JSONObject result = readResponse(code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream());
                    if (code != 200) throw new Exception(result.optString("error", "连接码验证失败（" + code + "）。"));
                    for (Map.Entry<String, List<String>> header : c.getHeaderFields().entrySet()) if ("Set-Cookie".equalsIgnoreCase(header.getKey())) {
                        for (String cookie : header.getValue()) if (cookie.startsWith("yingjian_session=")) responseCookies.add(cookie);
                    }
                    if (responseCookies.isEmpty()) throw new Exception("服务端未返回配对会话，请重新生成连接码后重试。");
                    alreadyPaired = true;
                } else if (!alreadyPaired && address.pairToken.isEmpty()) throw new Exception("请在电脑或 NAS 的“连接设备”中生成 6 位连接码，填写后再连接。");
            } catch (Exception e) { error = e.getMessage() == null ? "无法连接服务端" : e.getMessage(); }
            finally { if (c != null) c.disconnect(); }
            final String failure = error;
            final boolean paired = alreadyPaired;
            runOnUiThread(() -> {
                if (isFinishing() || generation != connectionGeneration) return;
                connecting = false;
                if (failure != null) { connectButton.setEnabled(true); connectButton.setText("重新连接"); message.setText("连接失败：" + failure + "\n请确认同一网络、地址及端口正确，连接码仍在有效期内。"); return; }
                origin = address.origin;
                Runnable enter = () -> {
                    if (isFinishing() || generation != connectionGeneration) return;
                    CookieManager.getInstance().flush(); codeInput.setText("");
                    if (paired) preferences.edit().putString("origin", origin).apply();
                    openBrowser(paired && address.pairToken.isEmpty() ? address.homeUrl(BuildConfig.TV_MODE) : address.connectUrl(BuildConfig.TV_MODE));
                };
                if (responseCookies.isEmpty()) enter.run();
                else {
                    CookieManager cookies = CookieManager.getInstance(); cookies.setAcceptCookie(true);
                    cookies.setCookie(origin, responseCookies.get(0), success -> {
                        if (isFinishing() || generation != connectionGeneration) return;
                        if (success) enter.run();
                        else { connectButton.setEnabled(true); connectButton.setText("重新连接"); message.setText("无法保存设备配对信息，请更新 Android System WebView 后重新生成连接码连接。"); }
                    });
                }
            });
        });
    }

    private JSONObject readResponse(InputStream input) throws Exception {
        if (input == null) throw new Exception("服务端没有返回有效响应，请检查地址和端口。");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = input) {
            byte[] buf = new byte[2048]; int count;
            while ((count = in.read(buf)) >= 0) { bytes.write(buf, 0, count); if (bytes.size() > 65536) throw new Exception("这不是映间服务端地址。"); }
        }
        try { return new JSONObject(bytes.toString("UTF-8")); }
        catch (Exception error) { throw new Exception("服务端响应无法识别，请确认填写的是映间服务端地址。"); }
    }

    private void openBrowser(String url) {
        root = new FrameLayout(this); root.setBackgroundColor(BG); setContentView(root);
        browser = new LinearLayout(this); browser.setOrientation(LinearLayout.VERTICAL); root.addView(browser, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(12), 0, dp(8), 0); bar.setBackgroundColor(BG);
        TextView host = label("局域网  ·  " + Uri.parse(origin).getAuthority(), 11, MUTED, false); bar.addView(host, new LinearLayout.LayoutParams(0, -2, 1));
        Button settings = button("连接设置", false); settings.setTextSize(11); settings.setMinHeight(0); settings.setMinimumHeight(0); settings.setPadding(dp(12), 0, dp(12), 0); settings.setOnClickListener(v -> showConnectionMenu());
        bar.addView(settings, new LinearLayout.LayoutParams(-2, dp(30))); browser.addView(bar, new LinearLayout.LayoutParams(-1, dp(40)));
        try { web = new WebView(this); }
        catch (RuntimeException error) { showSetup("此设备缺少可用的 Android System WebView。请更新系统 WebView 后重试。"); return; }
        browser.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false); s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false); s.setSupportMultipleWindows(false);
        // The connected LAN page controls playback; allow async resume and source changes after a user action.
        s.setMediaPlaybackRequiresUserGesture(false); s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " YingjianLAN/" + BuildConfig.VERSION_NAME + " " + (BuildConfig.TV_MODE ? "YingjianTV" : "YingjianPhone"));
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setBackgroundColor(BG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return request.isForMainFrame() ? handleNavigation(request.getUrl().toString(), request.hasGesture()) : !ServerAddress.sameOrigin(origin, request.getUrl().toString()); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String next) { return handleNavigation(next, false); }
            @Override public void onPageFinished(WebView view, String current) {
                CookieManager cookies = CookieManager.getInstance(); cookies.flush();
                String saved = cookies.getCookie(origin);
                if (ServerAddress.sameOrigin(origin, current) && "/".equals(Uri.parse(current).getPath()) && saved != null && saved.contains("yingjian_session=")) preferences.edit().putString("origin", origin).apply();
                if (BuildConfig.TV_MODE) view.requestFocus();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) new AlertDialog.Builder(MainActivity.this).setTitle("服务端暂时无法访问").setMessage("检查电脑或 NAS 是否已休眠、关闭，或家庭网络是否发生变化。")
                    .setPositiveButton("重试", (d, w) -> view.reload()).setNegativeButton("连接设置", (d, w) -> showSetup("请检查或更新服务端地址。")).show();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return; }
                fullscreen = view; fullscreenCallback = callback; browser.setVisibility(View.GONE); root.addView(view, new FrameLayout.LayoutParams(-1, -1));
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
            @Override public void onHideCustomView() { closeFullscreen(); }
        });
        web.setDownloadListener((u, ua, disposition, mime, length) -> Toast.makeText(this, "请在电脑端管理下载文件。", Toast.LENGTH_SHORT).show());
        web.loadUrl(url);
    }

    private boolean handleNavigation(String next, boolean gesture) {
        if (ServerAddress.sameOrigin(origin, next)) return false;
        Uri uri = Uri.parse(next);
        if (gesture && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) new AlertDialog.Builder(this).setTitle("在浏览器中打开外部链接？")
            .setMessage(uri.getHost()).setNegativeButton("取消", null).setPositiveButton("打开", (d, w) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception e) { Toast.makeText(this, "没有可用浏览器", Toast.LENGTH_SHORT).show(); } }).show();
        return true;
    }

    private void showConnectionMenu() {
        new AlertDialog.Builder(this).setTitle("当前服务端").setMessage(origin)
            .setPositiveButton("继续观看", null).setNeutralButton("更换服务端", (d, w) -> showSetup("输入新地址或扫描配对二维码。"))
            .setNegativeButton("退出应用", (d, w) -> finish()).show();
    }
    private void closeFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen); fullscreen = null; if (browser != null) browser.setVisibility(View.VISIBLE);
        root.setSystemUiVisibility(0); getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (fullscreenCallback != null) { fullscreenCallback.onCustomViewHidden(); fullscreenCallback = null; }
    }
    private void requestScan() {
        if (connecting) return;
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) { message.setText("此设备没有可用相机，请粘贴链接连接。"); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        else startActivityForResult(new Intent(this, ScanActivity.class), SCAN_REQUEST);
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == CAMERA_PERMISSION) { if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) requestScan(); else message.setText("相机权限未开启。可以粘贴链接连接，或在系统设置中开启相机权限。"); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCAN_REQUEST && result == RESULT_OK && data != null) connect(data.getStringExtra("result"), true);
    }
    @Override public void onBackPressed() {
        if (fullscreen != null) { closeFullscreen(); return; }
        if (web == null) { super.onBackPressed(); return; }
        final WebView current = web;
        current.evaluateJavascript("window.yingjianBack ? window.yingjianBack() : false", handled -> {
            if (web != current || isFinishing() || "true".equals(handled)) return;
            if (current.canGoBack()) current.goBack(); else showConnectionMenu();
        });
    }
    @Override public boolean onKeyDown(int key, KeyEvent event) {
        if (key == KeyEvent.KEYCODE_MENU && web != null) { showConnectionMenu(); return true; }
        return super.onKeyDown(key, event);
    }
    @Override protected void onPause() { if (web != null) { CookieManager.getInstance().flush(); web.onPause(); } super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { connectionGeneration++; network.shutdownNow(); if (web != null) web.destroy(); super.onDestroy(); }
    private int dp(float x) { return Math.round(x * getResources().getDisplayMetrics().density); }
    private TextView label(String text, int size, int color, boolean bold) { TextView t = new TextView(this); t.setText(text); t.setTextSize(size); t.setTextColor(color); if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD); return t; }
    private GradientDrawable round(int color, int radius) { GradientDrawable b = new GradientDrawable(); b.setColor(color); b.setCornerRadius(dp(radius)); return b; }
    private Button button(String text, boolean mint) {
        Button b = new Button(this); b.setText(text); b.setAllCaps(false); b.setTextSize(15); b.setTextColor(mint ? INK : Color.WHITE); b.setElevation(0);
        b.setBackground(round(mint ? MINT : INK, 26)); b.setStateListAnimator(null); b.setFocusable(true);
        b.setOnFocusChangeListener((v, focus) -> { if (BuildConfig.TV_MODE) { v.setScaleX(focus ? 1.035f : 1f); v.setScaleY(focus ? 1.035f : 1f); v.setBackground(round(focus ? 0xff02b995 : (mint ? MINT : INK), 26)); } });
        return b;
    }
}
