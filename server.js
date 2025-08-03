const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dgram = require('dgram');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const SCALE_IP = process.env.SCALE_IP || '192.168.4.1';
const SEND_PORT = 4444;  // PC sends to scale on port 4444 (XTREM side)
const RECEIVE_PORT = 5555; // PC receives from scale on port 5555 (PC side)

let currentWeight = '';
let isConnected = false;
let responseTimeout = null;
let reconnectTimeout = null;
let lastResponseTime = 0;

// Debug mode enabled with --debug flag
const DEBUG_MODE = process.argv.includes('--debug');

console.log('Weight Polling Test');
console.log('='.repeat(50));
if (DEBUG_MODE) {
    console.log('[DEBUG] Debug mode enabled');
}

const client = dgram.createSocket('udp4');

// Configure socket like C# does
client.on('error', (err) => {
    console.error('UDP socket error:', err);
});

// Enable socket reuse like C# does
try {
    client.setTTL(128);
    client.setBroadcast(false);
} catch (err) {
    if (DEBUG_MODE) {
        console.log('[DEBUG] Socket options error (may be normal):', err.message);
    }
}

client.on('message', (msg, rinfo) => {
    if (DEBUG_MODE) {
        console.log(`[DEBUG] Response from ${rinfo.address}:${rinfo.port}`);
        console.log(`[DEBUG] Size: ${msg.length} bytes`);
        console.log(`[DEBUG] Hex: ${msg.toString('hex')}`);
        console.log(`[DEBUG] ASCII: ${msg.toString('ascii')}`);
    }

    // Clear response timeout - we got a response
    if (responseTimeout) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
        if (DEBUG_MODE) {
            console.log('[DEBUG] Response timeout cleared');
        }
    }

    // Update connection status
    if (!isConnected) {
        console.log('[Server] Connection established');
    }
    isConnected = true;
    lastResponseTime = Date.now();

    // Parse message
    const ascii = msg.toString('ascii');

    // Try to identify message type
    if (msg.length > 40) {
        if (DEBUG_MODE) {
            console.log('[DEBUG] Looks like WEIGHT STREAM data');
        }
        // Try to parse weight
        try {
            const processed = ascii.substring(1, ascii.length - 4);
            if (DEBUG_MODE) {
                console.log(`[DEBUG] Processed: ${processed}`);
            }

            if (processed.length >= 37) {
                const brutWeight = processed.substring(12, 20);
                const tareWeight = processed.substring(23, 31);
                const unit = processed.substring(20, 22).trim();

                if (DEBUG_MODE) {
                    console.log(`[DEBUG] Weight info - Brut: ${brutWeight}, Tare: ${tareWeight}, Unit: ${unit}`);
                }

                // Update current weight and broadcast to web clients
                const brutWeightNum = parseFloat(brutWeight);
                const formattedWeight = `${brutWeightNum.toFixed(3)} ${unit}`;

                if (currentWeight !== formattedWeight) {
                    currentWeight = formattedWeight;
                    console.log('[Server] Weight:', formattedWeight);

                    const weightData = {
                        display: formattedWeight,
                        brut: brutWeightNum,
                        tare: parseFloat(tareWeight),
                        net: brutWeightNum - parseFloat(tareWeight),
                        unit: unit,
                        connected: true
                    };

                    io.emit('weight', weightData);
                    if (DEBUG_MODE) {
                        console.log('[DEBUG] Weight data emitted to WebSocket clients');
                    }
                }
            }
        } catch (err) {
            console.error('Parse error:', err.message);
        }
    }

    // In streaming mode, data comes automatically - no need to send commands
});

function sendNextCommand() {
    // Not used in streaming mode - scale sends data automatically
    if (DEBUG_MODE) {
        console.log('[DEBUG] In streaming mode - no need to send commands');
    }
}

function handleConnectionLoss() {
    if (isConnected) {
        isConnected = false;
        console.log('[Server] Connection lost, attempting to reconnect...');

        // Notify web clients about disconnection
        io.emit('weight', {
            display: 'Connection lost',
            connected: false
        });
    }

    // Clear any existing timeouts
    if (responseTimeout) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
    }

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    // Try to reconnect after 2 seconds
    reconnectTimeout = setTimeout(() => {
        console.log('[Server] Attempting to reconnect...');
        initializeScale(); // Re-send START command
    }, 2000);
}

function initializeScale() {
    // Send START command to enable streaming mode: \u000200FFE10110000\u0003\r\n
    const startBuffer = Buffer.from([0x02, 0x30, 0x30, 0x46, 0x46, 0x45, 0x31, 0x30, 0x31, 0x31, 0x30, 0x30, 0x30, 0x30, 0x03, 0x0D, 0x0A]);

    if (DEBUG_MODE) {
        console.log('[DEBUG] Sending START command to enable streaming mode...');
        console.log(`[DEBUG] START command hex: ${startBuffer.toString('hex')}`);
    } else {
        console.log('[Server] Starting weight streaming...');
    }

    client.send(startBuffer, SEND_PORT, SCALE_IP, (err) => {
        if (err) {
            console.error('Send error during initialization:', err);
            handleConnectionLoss();
            return;
        }

        if (DEBUG_MODE) {
            console.log('[DEBUG] START command sent - scale will now stream weight data');
        }

        // In streaming mode, the scale sends data automatically
        // No need to poll
    });
}

// Check connection health every 10 seconds
setInterval(() => {
    const timeSinceLastResponse = Date.now() - lastResponseTime;
    if (timeSinceLastResponse > 15000 && isConnected) { // 15 seconds without response
        console.log('[Server] No response for 15 seconds, connection may be lost');
        handleConnectionLoss();
    }
}, 10000);

client.on('listening', () => {
    const address = client.address();
    console.log(`Listening on ${address.address}:${address.port}`);

    // Don't initialize here - wait for connect callback
});

// Serve static files
app.use(express.static('public'));

app.get('/json', (req, res) => {
    // Extract numeric value from currentWeight (e.g., "0.162 kg" -> 0.162)
    let numericWeight = 0;
    if (currentWeight) {
        const match = currentWeight.match(/([\d.]+)/);
        if (match) {
            numericWeight = parseFloat(match[1]);
        }
    }

    res.json({
        weight: numericWeight
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('[Server] New WebSocket client connected - ID:', socket.id);

    // Send current weight immediately
    socket.emit('weight', {
        display: currentWeight || 'No data',
        connected: isConnected
    });

    socket.on('disconnect', () => {
        console.log('[Server] WebSocket client disconnected - ID:', socket.id);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Connecting to scale at ${SCALE_IP}...`);

    // Start UDP client - just bind, no connect needed
    client.bind(RECEIVE_PORT, () => {
        console.log(`[Server] Listening on port ${RECEIVE_PORT}`);

        // Initialize the scale after a short delay
        setTimeout(() => {
            console.log('[Server] Initializing scale...');
            initializeScale();
        }, 100);
    });
});

// Send STOP command to scale
function stopStreaming() {
    const stopBuffer = Buffer.from([0x02, 0x30, 0x30, 0x46, 0x46, 0x45, 0x31, 0x30, 0x31, 0x30, 0x30, 0x30, 0x30, 0x30, 0x03, 0x0D, 0x0A]);

    if (DEBUG_MODE) {
        console.log('[DEBUG] Sending STOP command...');
    }

    client.send(stopBuffer, SEND_PORT, SCALE_IP, (err) => {
        if (err && DEBUG_MODE) {
            console.error('[DEBUG] Error sending STOP:', err);
        }
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');

    // Send STOP command to scale
    stopStreaming();

    // Give it time to send the STOP command
    setTimeout(() => {
        client.close();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    }, 100);
});
