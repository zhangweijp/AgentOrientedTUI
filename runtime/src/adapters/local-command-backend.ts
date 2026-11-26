import { spawn } from 'node:child_process';
import type { AppExecutionBackend, AppExecutionIssue } from '../spi/runtime/execution-backend.js';
import { externalAppProtocol } from './external-app-protocol.js';

const maxLineBytes = 8 * 1024 * 1024;

export const localCommandBackend: AppExecutionBackend = {
    start(launch, emit) {
        const [program, ...args] = launch.command ?? [];
        if (!program) throw new Error('A registered App command is required.');
        const child = spawn(program, args, { shell: false, stdio: ['pipe', 'pipe', 'inherit'] });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let ended = false;
        let terminating = false;
        let exitIssue: AppExecutionIssue | undefined;
        let inputError: Error | undefined;
        let parts: Buffer[] = [];
        let bytes = 0;

        const protocol = externalAppProtocol(launch, packet => {
            if (ended || inputError || !child.stdin.writable)
                throw inputError ?? new Error('The App command input channel is closed.');
            child.stdin.write(JSON.stringify(packet) + '\n', 'utf8');
        }, emit);

        function end(issue?: AppExecutionIssue) {
            if (ended) return;
            ended = true;
            parts = [];
            emit({ kind: 'channelEnded', ...(issue ? { issue } : {}) });
        }

        function protocolError(message: string) {
            const issue = { code: 'APP_PROTOCOL_INVALID', message };
            end(issue);
            child.stdout.destroy();
        }

        function deliver() {
            const line = Buffer.concat(parts, bytes);
            parts = [];
            bytes = 0;
            try { protocol.receive(JSON.parse(decoder.decode(line))); }
            catch { protocolError('Invalid App command JSON-Lines packet.'); }
        }

        child.stdout.on('data', (chunk: Buffer) => {
            for (let start = 0; start < chunk.length && !ended;) {
                const newline = chunk.indexOf(0x0a, start);
                const last = newline < 0 ? chunk.length : newline;
                bytes += last - start;
                if (bytes > maxLineBytes) { protocolError('App command packet exceeds 8 MiB.'); return; }
                if (last > start) parts.push(chunk.subarray(start, last));
                if (newline >= 0) deliver();
                start = last + 1;
            }
        });
        child.stdout.once('end', () => {
            if (!ended && bytes) deliver();
            end(exitIssue);
        });
        child.stdout.once('close', () => end(exitIssue));
        child.stdout.on('error', () => end({ code: 'APP_COMMAND_OUTPUT_FAILED', message: 'The App command output could not be read.' }));
        child.stdin.on('error', (error: Error) => { inputError = error; });
        child.on('error', (error: Error) => {
            exitIssue ??= { code: child.pid ? 'APP_COMMAND_FAILED' : 'APP_COMMAND_START_FAILED', message: error.message };
            if (!child.pid) end(exitIssue);
        });
        child.once('close', (code, signal) => {
            end(exitIssue);
            const issue = exitIssue ?? (code === 0 || terminating && signal === 'SIGKILL' ? undefined : {
                code: 'APP_COMMAND_EXITED', message: `App command exited with ${signal ?? code}.`,
            });
            emit({ kind: 'exited', ...(issue ? { issue } : {}) });
        });

        return { send: protocol.send, terminate() {
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
            if (!child.kill('SIGKILL')) throw new Error('The App command could not be terminated.');
            terminating = true;
        } };
    },
};
