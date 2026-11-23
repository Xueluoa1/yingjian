package app.yingjian.lan;

import java.net.InetAddress;
import java.net.URI;
import java.util.Locale;

/** Small, platform-independent validator: never accepts an arbitrary website as a LAN server. */
public final class ServerAddress {
    public final String origin;
    public final String host;
    public final String pairToken;
    private ServerAddress(String origin, String host, String pairToken) { this.origin = origin; this.host = host; this.pairToken = pairToken; }

    public static ServerAddress parse(String input, boolean qr) {
        String value = input == null ? "" : input.trim();
        if (!value.contains("://") && !qr) value = "http://" + value;
        try {
            URI u = new URI(value);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            String host = u.getHost();
            if ((!scheme.equals("http") && !scheme.equals("https")) || host == null || u.getRawUserInfo() != null || u.getPort() == 0 || u.getPort() > 65535) throw new IllegalArgumentException();
            host = host.toLowerCase(Locale.ROOT);
            if (host.startsWith("[")) host = host.substring(1, host.length() - 1);
            boolean named = host.endsWith(".local") || host.endsWith(".lan");
            if (!named && !isPrivateLiteral(host)) throw new IllegalArgumentException();
            String path = u.getRawPath();
            if (path != null && !path.isEmpty() && !path.equals("/") && !path.equals("/connect")) throw new IllegalArgumentException();
            String fragment = u.getRawFragment();
            String token = "";
            if (fragment != null && !fragment.isEmpty()) {
                if (!fragment.matches("pair=[A-Za-z0-9_-]{20,256}")) throw new IllegalArgumentException();
                token = fragment.substring(5);
            }
            if (qr && (!"/connect".equals(path) || token.isEmpty())) throw new IllegalArgumentException();
            String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
            if (u.getPort() > 0) authority += ":" + u.getPort();
            return new ServerAddress(scheme + "://" + authority, host, token);
        } catch (Exception e) {
            throw new IllegalArgumentException(qr ? "请扫描服务端“连接设备”中生成的配对二维码。" : "请输入局域网地址，如 http://192.168.1.100:8080，或服务端生成的连接链接。");
        }
    }

    public String connectUrl(boolean tv) { return origin + "/connect?view=" + (tv ? "tv" : "mobile") + (pairToken.isEmpty() ? "" : "#pair=" + pairToken); }

    public static String pairingCode(String input) {
        String code = input == null ? "" : input.trim();
        if (!code.isEmpty() && !code.matches("[0-9]{6}")) throw new IllegalArgumentException("请输入服务端生成的 6 位数字连接码。");
        return code;
    }

    public String homeUrl(boolean tv) { return origin + "/?view=" + (tv ? "tv" : "mobile"); }

    public void verifyLocalResolution() throws Exception {
        for (InetAddress a : InetAddress.getAllByName(host)) if (!isPrivate(a.getAddress())) throw new IllegalArgumentException("该地址没有解析到局域网，请填写服务端显示的局域网 IP。");
    }

    public static boolean sameOrigin(String expected, String candidate) {
        try {
            URI a = new URI(expected), b = new URI(candidate);
            return b.getRawUserInfo() == null && a.getScheme().equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (Exception e) { return false; }
    }

    private static int port(URI u) { return u.getPort() < 0 ? ("https".equalsIgnoreCase(u.getScheme()) ? 443 : 80) : u.getPort(); }
    private static boolean isPrivateLiteral(String host) throws Exception {
        if (host.indexOf(':') >= 0) return host.matches("[0-9a-fA-F:]+") && isPrivate(InetAddress.getByName(host).getAddress());
        if (!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] p = host.split("\\."); byte[] b = new byte[4];
        for (int i = 0; i < 4; i++) { int n = Integer.parseInt(p[i]); if (n > 255 || (p[i].length() > 1 && p[i].startsWith("0"))) return false; b[i] = (byte)n; }
        return isPrivate(b);
    }
    private static boolean isPrivate(byte[] b) {
        if (b.length == 16) return (b[0] & 0xfe) == 0xfc;
        int a = b[0] & 255, c = b[1] & 255;
        return a == 10 || (a == 172 && c >= 16 && c <= 31) || (a == 192 && c == 168);
    }
}
