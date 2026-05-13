/**
 * ============================================================
 *  LiDAR WebSocket Bridge — Java  v1.1.0
 *  Reads from ESP32 via Serial and forwards to browser via WebSocket
 *
 *  FIX v1.1.0:
 *    - JSON command parsing (matches Node.js app.js format: {"type":"SCAN"})
 *    - Serial reconnect loop when port drops
 *    - lastScanData capped at MAX_SCAN_CACHE points
 *    - Full JSON control-character escaping (\r \t \b \f)
 *    - Port index bounds validation
 *    - Serial port null-data safety check
 *
 *  Dependencies (Maven):
 *    <dependency>
 *        <groupId>com.fazecast</groupId>
 *        <artifactId>jSerialComm</artifactId>
 *        <version>2.10.4</version>
 *    </dependency>
 *    <dependency>
 *        <groupId>org.java-websocket</groupId>
 *        <artifactId>Java-WebSocket</artifactId>
 *        <version>1.5.4</version>
 *    </dependency>
 * ============================================================
 */

import com.fazecast.jSerialComm.*;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.*;
import java.util.concurrent.*;

public class LidarServer extends WebSocketServer {

    // ── Settings ──────────────────────────────────────────
    private static final int    WS_PORT        = 8080;
    private static final String WS_HOST        = System.getProperty("lidar.host", "127.0.0.1");
    private static final int    BAUD_RATE      = 115200;
    // FIX: cap how many points we replay to new clients
    private static final int    MAX_SCAN_CACHE = 360;

    // ── Serial port ───────────────────────────────────────
    private volatile SerialPort serialPort;

    // ── Last scan cache ───────────────────────────────────
    private final List<String> lastScanData = new CopyOnWriteArrayList<>();
    private volatile boolean scanning = false;

    // ══════════════════════════════════════════════════════
    //  Constructor
    // ══════════════════════════════════════════════════════
    public LidarServer(SerialPort port) {
        super(new InetSocketAddress(WS_HOST, WS_PORT));
        this.serialPort = port;
    }

    // ══════════════════════════════════════════════════════
    //  WebSocket events
    // ══════════════════════════════════════════════════════
    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        System.out.println("[WS] Client connected: " + conn.getRemoteSocketAddress());

        // Replay last scan to the new client
        if (!lastScanData.isEmpty()) {
            conn.send("{\"type\":\"SCAN_START\"}");
            for (String point : lastScanData) conn.send(point);
            conn.send("{\"type\":\"SCAN_END\",\"points\":" + lastScanData.size() + "}");
        }

        conn.send("{\"type\":\"STATUS\",\"scanning\":" + scanning + "}");

        // Inform the browser whether hardware is connected
        boolean hwConnected = serialPort != null && serialPort.isOpen();
        conn.send("{\"type\":\"HARDWARE_STATUS\",\"connected\":" + hwConnected + "}");
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        System.out.println("[WS] Client disconnected: " + conn.getRemoteSocketAddress());
    }

    /**
     * FIX: The browser (app.js) sends JSON like {"type":"SCAN"}.
     * Previous code expected plain strings — now parses the JSON type field.
     */
    @Override
    public void onMessage(WebSocket conn, String message) {
        System.out.println("[WS] Command received: " + message);

        // Simple JSON type extraction — avoids a full JSON dependency
        String type = extractJsonStringField(message, "type");

        if (type == null) {
            System.out.println("[WARN] Could not parse command: " + message);
            return;
        }

        switch (type) {
            case "SCAN":      sendToESP32('S'); break;
            case "CALIBRATE": sendToESP32('C'); break;
            case "HOME":      sendToESP32('R'); break;
            case "INFO":      sendToESP32('I'); break;
            default:
                System.out.println("[WARN] Unknown command type: " + type);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        System.err.println("[ERROR] WebSocket error: " + ex.getMessage());
    }

    @Override
    public void onStart() {
        System.out.println("[WS] Server started on " + WS_HOST + ":" + WS_PORT);
    }

    // ══════════════════════════════════════════════════════
    //  Serial communication
    // ══════════════════════════════════════════════════════

    /** Sends one character command to ESP32. */
    private void sendToESP32(char cmd) {
        if (serialPort != null && serialPort.isOpen()) {
            try {
                serialPort.getOutputStream().write(cmd);
                serialPort.getOutputStream().flush();
                System.out.println("[SERIAL] Sent command: " + cmd);
            } catch (Exception e) {
                System.err.println("[ERROR] Send failed: " + e.getMessage());
            }
        } else {
            System.err.println("[WARN] Serial port not open — command dropped: " + cmd);
        }
    }

    /**
     * FIX: Reconnect loop — if the serial port dies (ESP32 reset/unplug),
     * we broadcast a HARDWARE_STATUS:false, wait 3 s, and try to reopen.
     */
    public void startSerialReading() {
        new Thread(() -> {
            while (true) {
                if (serialPort == null || !serialPort.isOpen()) {
                    broadcast("{\"type\":\"HARDWARE_STATUS\",\"connected\":false}");
                    System.out.println("[SERIAL] Port closed. Retrying in 3 s...");
                    try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
                    if (serialPort != null && !serialPort.isOpen()) {
                        serialPort.openPort();
                    }
                    continue;
                }

                try {
                    broadcast("{\"type\":\"HARDWARE_STATUS\",\"connected\":true}");
                    Scanner sc = new Scanner(serialPort.getInputStream());
                    System.out.println("[SERIAL] Reading started...");

                    while (sc.hasNextLine()) {
                        String line = sc.nextLine();
                        if (line == null) break; // FIX: null safety
                        line = line.trim();
                        if (line.isEmpty()) continue;

                        System.out.println("[SERIAL] << " + line);
                        processSerialLine(line);
                    }
                    // hasNextLine() returned false — port likely closed
                    System.out.println("[SERIAL] Stream ended.");

                } catch (Exception e) {
                    System.err.println("[SERIAL] Read error: " + e.getMessage());
                }

                // Short pause before reconnect attempt
                try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
            }
        }, "SerialReader").start();
    }

    /** Parses one line from ESP32 and broadcasts it as JSON. */
    private void processSerialLine(String line) {
        String json;

        if (line.equals("SCAN_START")) {
            scanning = true;
            lastScanData.clear();
            json = "{\"type\":\"SCAN_START\"}";
            broadcast(json);

        } else if (line.startsWith("SCAN_END")) {
            scanning = false;
            String[] parts = line.split(",");
            int validPoints = 0;
            if (parts.length > 1) {
                try { validPoints = Integer.parseInt(parts[1].trim()); }
                catch (NumberFormatException ignored) {}
            }
            json = "{\"type\":\"SCAN_END\",\"points\":" + validPoints + "}";
            broadcast(json);

        } else if (line.contains(",")) {
            // Format: angle,distance,status
            String[] parts = line.split(",");
            if (parts.length >= 2) {
                try {
                    int    angle  = Integer.parseInt(parts[0].trim());
                    int    dist   = Integer.parseInt(parts[1].trim());
                    String status = parts.length > 2 ? parts[2].trim() : "OK";

                    json = String.format(
                        "{\"type\":\"POINT\",\"angle\":%d,\"dist\":%d,\"status\":\"%s\"}",
                        angle, dist, status
                    );

                    // FIX: cap cache size to avoid unbounded growth
                    if (lastScanData.size() < MAX_SCAN_CACHE) {
                        lastScanData.add(json);
                    }
                    broadcast(json);

                } catch (NumberFormatException ignored) { /* skip malformed lines */ }
            }

        } else {
            // General log message (INFO, ERROR, OK, ...)
            json = String.format("{\"type\":\"LOG\",\"msg\":%s}", toJsonString(line));
            broadcast(json);
        }
    }

    /**
     * FIX: Escapes all JSON special and control characters.
     * Previous version only escaped \\ and \" — missing \r, \t, \b, \f.
     */
    private String toJsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    if (c < 0x20) {
                        // Other control characters -> unicode escape
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append("\"");
        return sb.toString();
    }

    /**
     * FIX: Simple JSON string-field extractor.
     * Extracts the value of a string field from a JSON object string,
     * e.g. extractJsonStringField("{\"type\":\"SCAN\"}", "type") -> "SCAN"
     */
    private String extractJsonStringField(String json, String field) {
        String key = "\"" + field + "\"";
        int keyIdx = json.indexOf(key);
        if (keyIdx < 0) return null;
        int colonIdx = json.indexOf(':', keyIdx + key.length());
        if (colonIdx < 0) return null;
        int startQuote = json.indexOf('"', colonIdx + 1);
        if (startQuote < 0) return null;
        int endQuote = json.indexOf('"', startQuote + 1);
        if (endQuote < 0) return null;
        return json.substring(startQuote + 1, endQuote);
    }

    // ══════════════════════════════════════════════════════
    //  Main
    // ══════════════════════════════════════════════════════
    public static void main(String[] args) throws Exception {

        SerialPort[] ports = SerialPort.getCommPorts();
        if (ports.length == 0) {
            System.err.println("[ERROR] No serial port found!");
            System.exit(1);
        }

        System.out.println("Available ports:");
        for (int i = 0; i < ports.length; i++) {
            System.out.printf("  [%d] %s — %s%n", i,
                ports[i].getSystemPortName(),
                ports[i].getDescriptivePortName());
        }

        int choice = 0;
        if (args.length > 0) {
            choice = Integer.parseInt(args[0]);
        } else {
            System.out.print("Choose port (Enter for " + ports[0].getSystemPortName() + "): ");
            Scanner input = new Scanner(System.in);
            String line = input.nextLine().trim();
            if (!line.isEmpty()) {
                try { choice = Integer.parseInt(line); }
                catch (NumberFormatException e) {
                    System.err.println("[ERROR] Invalid port number. Using 0.");
                    choice = 0;
                }
            }
        }

        // FIX: bounds check on port index
        if (choice < 0 || choice >= ports.length) {
            System.err.printf("[ERROR] Port index %d out of range (0-%d)%n",
                              choice, ports.length - 1);
            System.exit(1);
        }

        SerialPort port = ports[choice];
        port.setBaudRate(BAUD_RATE);
        port.setComPortTimeouts(SerialPort.TIMEOUT_READ_SEMI_BLOCKING, 0, 0);

        if (!port.openPort()) {
            System.err.println("[ERROR] Cannot open " + port.getSystemPortName());
            System.exit(1);
        }
        System.out.println("[OK] Connected to " + port.getSystemPortName());

        LidarServer server = new LidarServer(port);
        server.start();
        server.startSerialReading();

        System.out.println("\n─────────────────────────────────────");
        System.out.println("  Open index.html in your browser");
        System.out.println("  WebSocket: ws://" + WS_HOST + ":" + WS_PORT);
        System.out.println("  Stop: Ctrl+C");
        System.out.println("─────────────────────────────────────\n");

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                server.stop();
                port.closePort();
                System.out.println("\n[OK] Server stopped.");
            } catch (Exception e) {
                e.printStackTrace();
            }
        }));
    }
}
