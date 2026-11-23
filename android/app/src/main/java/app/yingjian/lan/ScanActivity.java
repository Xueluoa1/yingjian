package app.yingjian.lan;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Camera frames are decoded on-device. No photo is saved or uploaded. */
@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements SurfaceHolder.Callback {
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private final MultiFormatReader reader = new MultiFormatReader();
    private SurfaceView preview;
    private TextView message;
    private Camera camera;
    private boolean resumed, surfaceReady, finished;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        reader.setHints(hints);
        FrameLayout root = new FrameLayout(this); root.setBackgroundColor(Color.BLACK); setContentView(root);
        preview = new SurfaceView(this); preview.getHolder().addCallback(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        LinearLayout instructions = new LinearLayout(this); instructions.setOrientation(LinearLayout.VERTICAL);
        instructions.setPadding(dp(24), dp(24), dp(24), dp(24)); instructions.setBackgroundColor(0xb31a2322);
        FrameLayout.LayoutParams bottom = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM); root.addView(instructions, bottom);
        TextView title = new TextView(this); title.setText("扫描服务端配对二维码"); title.setTextColor(Color.WHITE); title.setTextSize(21); instructions.addView(title);
        message = new TextView(this); message.setText("打开电脑或 NAS 的“连接设备”，将二维码放入镜头内。\n扫码识别完全在此设备上完成。"); message.setTextColor(0xffb8d8d0); message.setTextSize(14); message.setPadding(0, dp(12), 0, dp(16)); instructions.addView(message);
        Button cancel = new Button(this); cancel.setText("返回，使用链接连接"); cancel.setAllCaps(false); cancel.setTextColor(0xff101414); cancel.setOnClickListener(v -> finish()); instructions.addView(cancel, new LinearLayout.LayoutParams(-1, dp(52)));
    }

    @Override protected void onResume() { super.onResume(); resumed = true; openCamera(); }
    @Override protected void onPause() { resumed = false; closeCamera(); super.onPause(); }
    @Override protected void onDestroy() { closeCamera(); decoder.shutdownNow(); super.onDestroy(); }
    @Override public void surfaceCreated(SurfaceHolder holder) { surfaceReady = true; openCamera(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { surfaceReady = false; closeCamera(); }

    private void openCamera() {
        if (!resumed || !surfaceReady || camera != null || finished) return;
        try {
            int index = 0;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) { Camera.getCameraInfo(i, info); if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { index = i; break; } }
            Camera.getCameraInfo(index, info);
            camera = Camera.open(index);
            Camera.Parameters settings = camera.getParameters();
            Camera.Size chosen = settings.getPreviewSize();
            long best = Long.MAX_VALUE;
            for (Camera.Size size : settings.getSupportedPreviewSizes()) {
                long score = Math.abs((long)size.width * size.height - 1280L * 720L);
                if (score < best) { chosen = size; best = score; }
            }
            settings.setPreviewSize(chosen.width, chosen.height);
            settings.setPreviewFormat(ImageFormat.NV21);
            List<String> modes = settings.getSupportedFocusModes();
            if (modes != null && modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) settings.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(settings);
            int degrees = getWindowManager().getDefaultDisplay().getRotation() * 90;
            int rotation = info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT ? (360 - (info.orientation + degrees) % 360) % 360 : (info.orientation - degrees + 360) % 360;
            camera.setDisplayOrientation(rotation);
            int displayWidth = getResources().getDisplayMetrics().widthPixels, displayHeight = getResources().getDisplayMetrics().heightPixels;
            float ratio = rotation % 180 == 0 ? (float)chosen.width / chosen.height : (float)chosen.height / chosen.width;
            int width = displayWidth, height = Math.round(width / ratio);
            if (height > displayHeight) { height = displayHeight; width = Math.round(height * ratio); }
            preview.setLayoutParams(new FrameLayout.LayoutParams(width, height, Gravity.CENTER));
            camera.setPreviewDisplay(preview.getHolder());
            final int frameWidth = chosen.width, frameHeight = chosen.height;
            camera.addCallbackBuffer(new byte[frameWidth * frameHeight * 3 / 2]);
            camera.setPreviewCallbackWithBuffer((data, activeCamera) -> decode(data, activeCamera, frameWidth, frameHeight));
            camera.startPreview();
        } catch (Exception error) { closeCamera(); message.setText("无法开启相机。请检查相机权限，或返回使用链接连接。"); }
    }

    private void decode(byte[] data, Camera activeCamera, int width, int height) {
        if (data == null || finished || !resumed) return;
        if (!decoding.compareAndSet(false, true)) { try { activeCamera.addCallbackBuffer(data); } catch (RuntimeException ignored) { } return; }
        decoder.execute(() -> {
            String value = null;
            try {
                PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
                Result result = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
                value = result.getText();
            } catch (Exception ignored) { }
            finally { reader.reset(); }
            final String decoded = value;
            runOnUiThread(() -> {
                decoding.set(false);
                if (!resumed || camera != activeCamera || finished) return;
                if (decoded != null) {
                    try {
                        ServerAddress.parse(decoded, true);
                        finished = true; closeCamera();
                        setResult(RESULT_OK, new Intent().putExtra("result", decoded)); finish(); return;
                    } catch (IllegalArgumentException e) { message.setText(e.getMessage()); }
                }
                try { activeCamera.addCallbackBuffer(data); } catch (RuntimeException ignored) { }
            });
        });
    }

    private void closeCamera() {
        Camera current = camera; camera = null;
        if (current != null) { try { current.setPreviewCallbackWithBuffer(null); current.stopPreview(); } catch (RuntimeException ignored) { } current.release(); }
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
