const { loadEnv } = require('./config/envVault');
loadEnv();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === 'true';
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const MAX_WS_PAYLOAD = 16 * 1024;
const EMAIL_LIMIT_COUNT = Number.parseInt(process.env.EMAIL_LIMIT_COUNT || '5', 10);
const EMAIL_LIMIT_WINDOW_MS = Number.parseInt(process.env.EMAIL_LIMIT_WINDOW_MS || '3600000', 10);

const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: verifyWsClient,
});

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Simulation State (Removed)
let isScanning = false;
let isSimulating = false;
let currentScanPoints = 0;
let serial = null;
let parser = null;
let hardwareConnected = false;

// Auto-detect Serial Port
async function initSerial() {
    try {
        const ports = await SerialPort.list();
        const target = process.env.SERIAL_PORT || (ports.find((p) => {
            const descriptor = `${p.path || ''} ${p.manufacturer || ''}`.toLowerCase();
            return descriptor.includes('usb') || descriptor.includes('acm') || descriptor.includes('cp210') || descriptor.includes('ch340');
        })?.path);
        
        if (target) {
            console.log(`Connecting to LiDAR on: ${target}`);
            serial = new SerialPort({ path: target, baudRate: 115200 });
            parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));
            
            serial.on('open', () => {
                hardwareConnected = true;
                broadcast({ type: 'HARDWARE_STATUS', connected: true });
            });
            
            serial.on('close', () => {
                const wasScanning = isScanning;
                hardwareConnected = false;
                isScanning = false;
                broadcast({ type: 'HARDWARE_STATUS', connected: false });
                if (wasScanning) broadcast({ type: 'SCAN_END', points: currentScanPoints });
                currentScanPoints = 0;
            });
            
            serial.on('error', (err) => {
                hardwareConnected = false;
                isScanning = false;
                console.error('Serial Error:', err.message);
                broadcast({ type: 'HARDWARE_STATUS', connected: false });
            });
            
            // Listen for real data from hardware
            parser.on('data', (data) => {
                handleSerialLine(data);
            });
        } else {
            console.warn('No LiDAR hardware detected. Please connect via USB.');
        }
    } catch (err) {
        console.error('Serial Init Error:', err);
    }
}

function handleSerialLine(raw) {
    const line = String(raw || '').trim();
    if (!line) return;

    if (line === 'SCAN_START') {
        isScanning = true;
        currentScanPoints = 0;
        broadcast({ type: 'SCAN_START' });
        return;
    }

    if (line.startsWith('SCAN_END')) {
        const [, count] = line.split(',');
        const parsedCount = Number.parseInt(count, 10);
        isScanning = false;
        broadcast({
            type: 'SCAN_END',
            points: Number.isFinite(parsedCount) ? parsedCount : currentScanPoints,
        });
        currentScanPoints = 0;
        return;
    }

    if (line.includes(',')) {
        // Firmware format: "angle,distance,status"
        const [angle, dist, status = 'OK'] = line.split(',');
        const angleInt = Number.parseInt(angle, 10);
        const distInt = Number.parseInt(dist, 10);
        const cleanStatus = status.trim() === 'OK' ? 'OK' : 'ERR';

        if (Number.isInteger(angleInt) && Number.isInteger(distInt) && angleInt >= 0 && angleInt < 360) {
            if (cleanStatus === 'OK' && distInt > 0) currentScanPoints++;
            broadcast({
                type: 'POINT',
                angle: angleInt,
                dist: distInt,
                status: cleanStatus,
            });
        }
        return;
    }

    broadcast({ type: 'LOG', msg: line, level: line.includes('ERROR') ? 'err' : 'info' });
}

initSerial();

function sendLog(ws, msg, level = 'info') {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'LOG', msg, level }));
    }
}

function serialReady() {
    return serial && hardwareConnected && serial.isOpen !== false;
}

function writeSerialCommand(command, ws, description) {
    if (!serialReady()) {
        sendLog(ws, 'Cannot send command: No LiDAR hardware detected', 'err');
        return false;
    }

    serial.write(command, (err) => {
        if (err) {
            sendLog(ws, `Serial write failed: ${err.message}`, 'err');
            return;
        }
        sendLog(ws, `→ ${description} command sent to hardware`, 'info');
    });
    return true;
}

function canSendEmail(ws) {
    const now = Date.now();
    ws.emailTimestamps = (ws.emailTimestamps || []).filter((ts) => now - ts < EMAIL_LIMIT_WINDOW_MS);
    if (ws.emailTimestamps.length >= EMAIL_LIMIT_COUNT) return false;
    ws.emailTimestamps.push(now);
    return true;
}

// WebSocket logic
wss.on('connection', (ws, req) => {
    ws.emailTimestamps = [];
    console.log('Client connected');
    
    // Send initial status
    ws.send(JSON.stringify({ type: 'STATUS', scanning: isScanning, battery: 85 }));
    ws.send(JSON.stringify({ type: 'HARDWARE_STATUS', connected: hardwareConnected }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString('utf8'));
            if (!data || typeof data.type !== 'string') {
                throw new Error('Invalid command payload');
            }
            console.log(`[${new Date().toLocaleTimeString()}] Action: ${data.type}`);

            switch (data.type) {
                case 'SCAN':
                    if (isScanning) {
                        sendLog(ws, 'Scan already in progress', 'err');
                        break;
                    }
                    writeSerialCommand('S', ws, 'SCAN');
                    break;
                case 'STOP_SCAN':
                    sendLog(ws, 'Stop scan is not supported by the current ESP32 firmware', 'err');
                    break;
                case 'CALIBRATE':
                    writeSerialCommand('C', ws, 'CALIBRATE');
                    break;
                case 'HOME':
                    if (isScanning) {
                        sendLog(ws, 'Cannot home while a scan is active', 'err');
                        break;
                    }
                    writeSerialCommand('R', ws, 'HOME');
                    break;
                case 'INFO':
                    writeSerialCommand('I', ws, 'INFO');
                    break;
                case 'SEND_EMAIL':
                    if (!canSendEmail(ws)) {
                        sendLog(ws, 'Email rate limit reached. Try again later.', 'err');
                        break;
                    }
                    await handleEmail(data.payload, ws);
                    break;
                case 'SIMULATE_SCAN':
                    if (isScanning || isSimulating) {
                        sendLog(ws, 'Scan already in progress', 'err');
                        break;
                    }
                    startSimulation(ws);
                    break;
                default:
                    console.warn(`Unknown command: ${data.type}`);
            }
        } catch (err) {
            console.error('Message handling error:', err);
            ws.send(JSON.stringify({ type: 'LOG', msg: `Server Error: ${err.message}`, level: 'err' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Simulation Logic
function startSimulation(ws) {
    isSimulating = true;
    isScanning = true;
    currentScanPoints = 0;
    
    broadcast({ type: 'SCAN_START' });
    sendLog(ws, 'Starting randomized simulated scan...', 'info');

    // Pick a random shape type for this scan
    const shapeType = ['RECT', 'CIRCLE', 'STAR', 'NOISE'][Math.floor(Math.random() * 4)];
    const baseDist = 80 + Math.random() * 100; // Randomize base size

    let angle = 0;
    const interval = setInterval(() => {
        if (!isSimulating) {
            clearInterval(interval);
            return;
        }

        const rad = (angle * Math.PI) / 180;
        let dist = baseDist;
        const noise = Math.random() * 8 - 4;

        if (shapeType === 'RECT') {
            const wallFactor = 1 / Math.max(Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad)));
            dist = baseDist * wallFactor;
        } else if (shapeType === 'STAR') {
            const starFactor = 1 + 0.5 * Math.abs(Math.sin(rad * 5)); // 5-pointed star
            dist = baseDist * starFactor;
        } else if (shapeType === 'CIRCLE') {
            dist = baseDist;
        } else {
            // Pure noise / cloud
            dist = baseDist + Math.random() * 150;
        }

        dist = Math.round(dist + noise);

        broadcast({
            type: 'POINT',
            angle: angle,
            dist: dist,
            status: 'OK'
        });
        currentScanPoints++;

        angle++;
        if (angle >= 360) {
            clearInterval(interval);
            isSimulating = false;
            isScanning = false;
            broadcast({ type: 'SCAN_END', points: currentScanPoints });
            sendLog(ws, `Simulated ${shapeType} scan completed.`, 'ok');
            currentScanPoints = 0;
        }
    }, 15); // Slightly faster scan
}


async function handleEmail(payload, ws) {
    const { to, subject, maps } = normalizeEmailPayload(payload);
    
    sendLog(ws, `Attempting to send email to ${to}...`);

    try {
        let transporter;
        
        // Use real SMTP if configured in .env
        if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            if (!process.env.SMTP_HOST) {
                throw new Error('SMTP_HOST is required when SMTP credentials are configured');
            }
            transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number.parseInt(process.env.SMTP_PORT || '587', 10),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
        } else {
            // Fallback to Ethereal test account
            let testAccount = await nodemailer.createTestAccount();
            transporter = nodemailer.createTransport({
                host: "smtp.ethereal.email",
                port: 587,
                secure: false,
                auth: {
                    user: testAccount.user,
                    pass: testAccount.pass,
                },
            });
        }

        const attachments = [];
        const mapList = maps.map((m, i) => {
            const cid = `mapimage_${i}`;
            if (m.thumbnail && m.thumbnail.startsWith('data:image/')) {
                const base64Data = m.thumbnail.split(',')[1];
                attachments.push({
                    filename: `map_${i}.png`,
                    content: base64Data,
                    encoding: 'base64',
                    cid: cid
                });
            }

            return `
                <li style="margin-bottom: 20px; list-style: none; border-bottom: 1px solid #eee; padding-bottom: 15px;">
                    <div style="font-weight: bold; font-size: 1.1em; color: #38bdf8;">${escapeHtml(m.name)}</div>
                    <div style="font-size: 0.85em; color: #666;">${escapeHtml(m.date)} — ${m.points} points</div>
                    ${m.thumbnail ? `<div style="margin-top: 10px;"><img src="cid:${cid}" width="200" height="200" style="border: 2px solid #38bdf8; border-radius: 8px; background: #0a0e1a;"></div>` : ''}
                </li>
            `;
        }).join('');
        
        let info = await transporter.sendMail({
            from: process.env.SMTP_FROM || '"LiDAR System" <no-reply@lidar-vr.com>',
            to,
            subject,
            html: `
                <div style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto;">
                    <h2 style="color: #38bdf8; border-bottom: 2px solid #38bdf8; padding-bottom: 10px;">LiDAR Scan Report</h2>
                    <p>The following scans have been generated by the VR Interface:</p>
                    <ul style="padding: 0;">${mapList}</ul>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="font-size: 0.8em; color: #999; text-align: center;">This is an automated report from the LiDAR 360° VR System.</p>
                </div>
            `,
            attachments: attachments
        });

        const previewUrl = nodemailer.getTestMessageUrl(info);
        console.log("Message sent: %s", info.messageId);
        if (previewUrl) console.log("Preview URL: %s", previewUrl);

        sendLog(ws, previewUrl ? `Email sent! Preview link: ${previewUrl}` : 'Email sent.');
    } catch (err) {
        console.error(err);
        sendLog(ws, `Email error: ${err.message}`, 'err');
    }
}

function normalizeEmailPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid email payload');
    }

    const to = limitString(payload.to, 254).trim();
    const subject = limitString(payload.subject || 'LiDAR Scan Report', 140).trim();

    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to)) {
        throw new Error('Invalid recipient email');
    }

    if (!Array.isArray(payload.maps) || payload.maps.length === 0) {
        throw new Error('No maps selected for email');
    }

    const maps = payload.maps.slice(0, 20).map((map) => {
        const points = Number.parseInt(map?.points, 10);
        return {
            name: limitString(map?.name || 'Untitled scan', 80),
            date: limitString(map?.date || '', 80),
            points: Number.isFinite(points) && points >= 0 ? Math.min(points, 1000000) : 0,
            thumbnail: typeof map?.thumbnail === 'string' && map.thumbnail.length < 500000 ? map.thumbnail : null,
        };
    });

    return { to, subject, maps };
}

function limitString(value, max) {
    return String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, max);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function verifyWsClient(info, done) {
    const remoteAddress = info.req.socket.remoteAddress || '';

    if (!ALLOW_REMOTE && !isLoopback(remoteAddress)) {
        return done(false, 403, 'Remote WebSocket access is disabled');
    }

    if (CONTROL_TOKEN) {
        const url = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token') || info.req.headers['x-lidar-token'];
        if (token !== CONTROL_TOKEN) {
            return done(false, 401, 'Invalid control token');
        }
    }

    return done(true);
}

function isLoopback(address) {
    const normalized = address.replace(/^::ffff:/, '');
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function handleServerError(err) {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Set PORT in .env.enc/.env or stop the other process.`);
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
        console.error(`Cannot listen on ${HOST}:${PORT}. Check permissions or choose another PORT.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
}

server.on('error', handleServerError);
wss.on('error', handleServerError);

server.listen(PORT, HOST, () => {
    const address = server.address();
    const displayPort = address && typeof address === 'object' ? address.port : PORT;
    console.log(`Server running at http://${HOST}:${displayPort}`);
});
