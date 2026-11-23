import app.yingjian.lan.ServerAddress;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;

public final class QrCodecTest {
    public static void main(String[] args) throws Exception {
        String url = "http://192.168.2.20:8080/connect#pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
        BitMatrix matrix = new MultiFormatWriter().encode(url, BarcodeFormat.QR_CODE, 480, 480);
        int[] pixels = new int[480 * 480];
        for (int y = 0; y < 480; y++) for (int x = 0; x < 480; x++) pixels[y * 480 + x] = matrix.get(x, y) ? 0xff000000 : 0xffffffff;
        String decoded = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(480, 480, pixels)))).getText();
        if (!url.equals(decoded)) throw new AssertionError("QR content changed");
        if (!ServerAddress.parse(decoded, true).connectUrl(false).contains("?view=mobile#pair=")) throw new AssertionError("Pair token not preserved");
        System.out.println("PASS offline QR encode/decode and mobile pairing URL");
    }
}
