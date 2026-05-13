/**
 * ============================================================
 *  360° LiDAR Scanner — ESP32 + Benewake TF-Luna  v1.1.0
 *  Robotics for Bulgaria, Season 10
 *
 *  FIX v1.1.0:
 *    - Removed UART header check (0x59 0x59) — not present in I2C mode
 *    - Added signal-strength validity check
 *    - Replaced integer steps/sample with float accumulator (eliminates ~79° drift)
 *    - Added concurrent-scan guard
 *    - Added HOME guard during active scan
 *    - Added scan status in print_info()
 * ============================================================
 *
 *  Wiring:
 *    TF-Luna SDA  ->  GPIO 21
 *    TF-Luna SCL  ->  GPIO 22
 *    TF-Luna VCC  ->  3.3V
 *    TF-Luna GND  ->  GND
 *    Motor STEP   ->  GPIO 18
 *    Motor DIR    ->  GPIO 19
 *    Motor EN     ->  GPIO 5  (LOW = active)
 *
 *  Serial commands (115200 baud):
 *    'S' — start 360° scan
 *    'C' — calibrate (10 averaged readings)
 *    'R' — return motor to home position
 *    'I' — print system info
 * ============================================================
 */

#include <Arduino.h>
#include <Wire.h>

// ─── Pins ─────────────────────────────────────────────────
constexpr uint8_t PIN_SDA    = 21;
constexpr uint8_t PIN_SCL    = 22;
constexpr uint8_t PIN_STEP   = 18;
constexpr uint8_t PIN_DIR    = 19;
constexpr uint8_t PIN_ENABLE = 5;   // LOW = motor active

// ─── TF-Luna I2C settings ─────────────────────────────────
constexpr uint8_t TF_LUNA_ADDR     = 0x10;
constexpr uint8_t TF_LUNA_REG_DIST = 0x00; // distance register (I2C mode)
constexpr uint8_t TF_LUNA_I2C_LEN  = 7;    // bytes to read in I2C mode
constexpr int     TF_LUNA_MAX_CM   = 800;
constexpr int     TF_LUNA_MIN_CM   = 10;
constexpr uint8_t CALIBRATION_REPS = 10;

// ─── Motor settings ───────────────────────────────────────
constexpr int STEPS_PER_REV  = 2048; // 28BYJ-48
constexpr int SAMPLES        = 360;
constexpr int STEP_DELAY_US  = 500;
constexpr int SETTLE_DELAY_MS = 40;

// ─── Firmware version ─────────────────────────────────────
constexpr char FIRMWARE_VERSION[] = "1.1.0";

// ─── Global state ─────────────────────────────────────────
bool     g_sensorOk  = false;
bool     g_scanning  = false;
uint32_t g_scanCount = 0;


// ══════════════════════════════════════════════════════════
//  TF-Luna functions  (I2C mode — NO UART 0x59 0x59 header)
// ══════════════════════════════════════════════════════════

bool tfLuna_init() {
    Wire.beginTransmission(TF_LUNA_ADDR);
    uint8_t err = Wire.endTransmission();
    if (err != 0) {
        Serial.printf("[ERROR] TF-Luna not found at 0x%02X (err: %d)\n", TF_LUNA_ADDR, err);
        return false;
    }
    Serial.printf("[OK] TF-Luna found at 0x%02X\n", TF_LUNA_ADDR);
    return true;
}

/**
 * Read one distance sample from TF-Luna via I2C.
 *
 * In I2C mode the sensor exposes registers directly — there is NO
 * UART frame header (0x59 0x59). Layout starting at register 0x00:
 *   Byte 0: distance LSB
 *   Byte 1: distance MSB  -> dist = buf[0] | buf[1]<<8  (cm)
 *   Byte 2: strength LSB
 *   Byte 3: strength MSB  -> 0 or 65535 means invalid
 *   Byte 4: temperature LSB
 *   Byte 5: temperature MSB
 *   Byte 6: reserved
 *
 * @return distance in cm, or -1 on error
 */
int tfLuna_read() {
    Wire.beginTransmission(TF_LUNA_ADDR);
    Wire.write(TF_LUNA_REG_DIST);
    // repeated-start (false) keeps the bus owned for the read
    if (Wire.endTransmission(false) != 0) return -1;

    Wire.requestFrom(TF_LUNA_ADDR, TF_LUNA_I2C_LEN);
    if (Wire.available() < TF_LUNA_I2C_LEN) return -1;

    uint8_t buf[TF_LUNA_I2C_LEN];
    for (int i = 0; i < TF_LUNA_I2C_LEN; i++) buf[i] = Wire.read();

    // Distance (little-endian, bytes 0-1)
    int dist = buf[0] | (buf[1] << 8);

    // Signal strength (bytes 2-3) — 0 or 0xFFFF means no valid return
    int strength = buf[2] | (buf[3] << 8);
    if (strength == 0 || strength == 65535) return -1;

    // Range check
    if (dist < TF_LUNA_MIN_CM || dist > TF_LUNA_MAX_CM) return -1;

    return dist;
}

int tfLuna_readAverage() {
    int sum = 0, valid = 0;
    for (int i = 0; i < CALIBRATION_REPS; i++) {
        int d = tfLuna_read();
        if (d > 0) { sum += d; valid++; }
        delay(5);
    }
    return (valid > 0) ? (sum / valid) : -1;
}


// ══════════════════════════════════════════════════════════
//  Motor functions
// ══════════════════════════════════════════════════════════

void motor_init() {
    pinMode(PIN_STEP,   OUTPUT);
    pinMode(PIN_DIR,    OUTPUT);
    pinMode(PIN_ENABLE, OUTPUT);
    digitalWrite(PIN_ENABLE, HIGH); // disabled by default
    Serial.println("[OK] Motor initialised");
}

void motor_enable()  { digitalWrite(PIN_ENABLE, LOW);  }
void motor_disable() { digitalWrite(PIN_ENABLE, HIGH); }

void motor_step(int steps, bool clockwise) {
    digitalWrite(PIN_DIR, clockwise ? HIGH : LOW);
    for (int i = 0; i < steps; i++) {
        digitalWrite(PIN_STEP, HIGH); delayMicroseconds(STEP_DELAY_US);
        digitalWrite(PIN_STEP, LOW);  delayMicroseconds(STEP_DELAY_US);
    }
}

void motor_home() {
    Serial.println("[INFO] Returning to home...");
    motor_enable();
    motor_step(STEPS_PER_REV, false);
    motor_disable();
    Serial.println("[OK] Home position reached");
}


// ══════════════════════════════════════════════════════════
//  Scan functions
// ══════════════════════════════════════════════════════════

/**
 * Full 360° scan.
 *
 * FIX: Integer division 2048/360 = 5 discards 448 steps,
 * causing ~79° of drift per revolution.
 * Solution: float accumulator distributes the fractional
 * step evenly across all 360 samples — zero net drift.
 */
void scan_full() {
    if (!g_sensorOk) {
        Serial.println("[ERROR] Sensor not ready. Aborting.");
        return;
    }
    // FIX: guard against concurrent scan
    if (g_scanning) {
        Serial.println("[WARN] Scan already in progress. Please wait.");
        return;
    }

    g_scanning = true;
    int validPoints = 0;

    Serial.println("SCAN_START");
    motor_enable();

    // FIX: accumulator prevents integer-rounding drift
    float accumulator = 0.0f;
    const float stepsPerSample = (float)STEPS_PER_REV / (float)SAMPLES;

    for (int i = 0; i < SAMPLES; i++) {
        accumulator += stepsPerSample;
        int stepsNow = (int)accumulator;
        accumulator -= (float)stepsNow; // keep fractional remainder

        motor_step(stepsNow, true);
        delay(SETTLE_DELAY_MS);

        int dist = tfLuna_read();
        if (dist > 0) {
            Serial.printf("%d,%d,OK\n", i, dist);
            validPoints++;
        } else {
            Serial.printf("%d,-1,ERR\n", i);
        }
    }

    motor_step(STEPS_PER_REV, false); // return to home
    motor_disable();

    g_scanning = false;
    g_scanCount++;

    Serial.printf("SCAN_END,%d\n", validPoints);
    Serial.printf("[INFO] Scan #%lu done — %d/%d valid points\n",
                  g_scanCount, validPoints, SAMPLES);
}

void scan_calibrate() {
    if (g_scanning) { Serial.println("[WARN] Scan active. Wait."); return; }
    Serial.println("[INFO] Calibrating — hold object at known distance...");
    delay(2000);
    int result = tfLuna_readAverage();
    if (result > 0) Serial.printf("[CALIB] Distance: %d cm\n", result);
    else            Serial.println("[ERROR] Calibration failed — check sensor");
}

void i2c_scan() {
    Serial.println("[INFO] Scanning I2C bus...");
    int found = 0;
    for (int addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  -> Device at: 0x%02X\n", addr);
            found++;
        }
    }
    if (found == 0) Serial.println("  No devices found!");
    else Serial.printf("[INFO] Found %d device(s)\n", found);
}

void print_info() {
    Serial.println("=== LiDAR Scanner — System Info ===");
    Serial.printf("  Firmware        : %s\n",   FIRMWARE_VERSION);
    Serial.printf("  Sensor OK       : %s\n",   g_sensorOk ? "YES" : "NO");
    Serial.printf("  Scanning        : %s\n",   g_scanning ? "YES" : "NO");
    Serial.printf("  Completed scans : %lu\n",  g_scanCount);
    Serial.printf("  Samples/rev     : %d\n",   SAMPLES);
    Serial.printf("  Steps/rev       : %d\n",   STEPS_PER_REV);
    Serial.printf("  Steps/sample    : %.4f\n", (float)STEPS_PER_REV / SAMPLES);
    Serial.printf("  Min distance    : %d cm\n", TF_LUNA_MIN_CM);
    Serial.printf("  Max distance    : %d cm\n", TF_LUNA_MAX_CM);
    Serial.println("====================================");
    Serial.println("Commands: S=scan  C=calibrate  R=home  I=info");
}


// ══════════════════════════════════════════════════════════
//  Setup & Loop
// ══════════════════════════════════════════════════════════

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println("\n========================================");
    Serial.println("  LiDAR Scanner v" FIRMWARE_VERSION);
    Serial.println("  Robotics for Bulgaria — Season 10");
    Serial.println("========================================");

    Wire.begin(PIN_SDA, PIN_SCL);
    Wire.setClock(400000); // 400kHz Fast Mode

    motor_init();

    g_sensorOk = tfLuna_init();
    if (!g_sensorOk) {
        Serial.println("[WARN] Continuing without sensor — motor only");
        i2c_scan();
    }

    print_info();
    Serial.println("\nREADY. Send a command:");
}

void loop() {
    if (!Serial.available()) return;

    char cmd = Serial.read();
    while (Serial.available()) Serial.read(); // flush newline chars

    switch (cmd) {
        case 'S': case 's': scan_full();      break;
        case 'C': case 'c': scan_calibrate(); break;
        case 'R': case 'r':
            if (g_scanning) Serial.println("[WARN] Cannot home during scan.");
            else             motor_home();
            break;
        case 'I': case 'i': print_info(); break;
        default:
            Serial.printf("[WARN] Unknown command: '%c'\n", cmd);
            Serial.println("Commands: S=scan  C=calibrate  R=home  I=info");
            break;
    }
}
