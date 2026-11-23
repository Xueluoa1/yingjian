import app.yingjian.lan.ServerAddress;
public class ServerAddressTest {
    static int checks;
    static void ok(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    static void rejects(String value, boolean qr) { try { ServerAddress.parse(value, qr); throw new AssertionError(value); } catch (IllegalArgumentException expected) { checks++; } }
    static void rejectsCode(String value) { try { ServerAddress.pairingCode(value); throw new AssertionError(value); } catch (IllegalArgumentException expected) { checks++; } }
    public static void main(String[] args) {
        ok(ServerAddress.parse("192.168.1.9:8080", false).connectUrl(false).equals("http://192.168.1.9:8080/connect?view=mobile"));
        String pair = "http://10.0.0.1:8080/connect#pair=abcdefghijklmnopqrstuvwxyz123456";
        ok(ServerAddress.parse(pair, true).connectUrl(true).contains("view=tv#pair="));
        ok(ServerAddress.parse("https://nas.local:8443", false).origin.equals("https://nas.local:8443"));
        ok(ServerAddress.parse("http://[fd12::1]:8080", false).host.equals("fd12::1"));
        ok(ServerAddress.parse(" 192.168.2.20:8080 ", false).homeUrl(true).equals("http://192.168.2.20:8080/?view=tv"));
        ok(ServerAddress.parse("192.168.2.20:8080/", false).origin.equals("http://192.168.2.20:8080"));
        ok(ServerAddress.parse("nas.lan:8080", false).origin.equals("http://nas.lan:8080"));
        ok(ServerAddress.parse(pair, false).pairToken.equals("abcdefghijklmnopqrstuvwxyz123456"));
        ok(ServerAddress.parse("172.16.0.1:8080", false).origin.equals("http://172.16.0.1:8080"));
        rejects("172.32.0.1:8080", false); rejects("192.168.2.20:0", false);
        rejects("192.168.2.20:8080@8.8.8.8", false); rejects("192.168.2.20:8080/connect#pair=bad", false);
        ok(ServerAddress.pairingCode("001234").equals("001234"));
        ok(ServerAddress.pairingCode(" 000000 ").equals("000000"));
        ok(ServerAddress.pairingCode("").isEmpty()); ok(ServerAddress.pairingCode(null).isEmpty());
        rejectsCode("12345"); rejectsCode("1234567"); rejectsCode("12 3456"); rejectsCode("１２３４５６"); rejectsCode("+12345"); rejectsCode("12345x");
        rejects("https://example.com/connect#pair=abcdefghijklmnopqrstuvwxyz", true);
        rejects("http://8.8.8.8", false); rejects("file:///sdcard/test", false); rejects("javascript:alert(1)", false);
        rejects("http://name:password@192.168.1.1:8080", false); rejects("http://192.168.1.1:99999", false);
        rejects("http://192.168.1.1/evil", false); rejects("http://192.168.1.1/connect#pair=short", true);
        rejects("http://192.168.1.1", true); rejects("http://192.168.001.1", false);
        rejects("http://127.0.0.1", false); rejects("http://169.254.169.254", false);
        ok(ServerAddress.sameOrigin("http://192.168.1.1:80", "http://192.168.1.1/path"));
        ok(!ServerAddress.sameOrigin("http://192.168.1.1:8080", "http://192.168.1.1:9000/path"));
        ok(!ServerAddress.sameOrigin("http://192.168.1.1", "http://192.168.1.1.evil.com"));
        System.out.println("PASS " + checks + " address / origin / pairing code checks");
    }
}
