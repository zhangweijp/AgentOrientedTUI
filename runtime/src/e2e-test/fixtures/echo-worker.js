import { parentPort } from 'worker_threads';

// Mimic SDK Runtime behavior
if (parentPort) {
    // 1. Send READY
    parentPort.postMessage({ type: 'READY' });

    // 2. Listen for INIT
    parentPort.on('message', (msg) => {
        if (msg.type === 'INIT') {
            const config = msg.config;
            const requestId = msg.requestId;
            const appInstanceId = msg.appInstanceId;

            // 3. Complete the current managed INIT handshake before echoing config.
            parentPort.postMessage({
                type: 'INIT_RESPONSE',
                requestId: requestId,
                success: true,
                appInstanceId,
                acceptedCapabilities: msg.requestedCapabilities,
                appLifecycle: {
                    protocol: 'app-lifecycle-v2',
                    version: 2,
                    instanceId: appInstanceId
                },
                persistence: {
                    protocol: 'state-session-v1',
                    version: 1,
                    instanceId: appInstanceId
                }
            });

            // 4. Send Custom Validation Message (Verification)
            parentPort.postMessage({
                type: 'ECHO_CONFIG',
                config: config
            });
        }
    });
}
