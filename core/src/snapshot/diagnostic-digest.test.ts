import { describe, expect, it } from 'vitest';
import { diagnosticDigest } from './json.js';

function referenceBigIntDigest(bytes: Uint8Array): string {
    let value = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
    }
    return 'fnv1a64:' + value.toString(16).padStart(16, '0');
}

describe('diagnosticDigest', () => {
    it('matches reference BigInt FNV-1a across empty, boundary bytes, UTF-8, lengths 0..512, and PRNG samples', () => {
        expect(diagnosticDigest(new Uint8Array())).toBe(referenceBigIntDigest(new Uint8Array()));

        for (let b = 0; b <= 0xff; b++) {
            const single = new Uint8Array([b]);
            expect(diagnosticDigest(single)).toBe(referenceBigIntDigest(single));
        }

        const boundaryPairs = [
            new Uint8Array([0x00, 0x00]),
            new Uint8Array([0xff, 0xff]),
            new Uint8Array([0x00, 0xff, 0x00, 0xff]),
            new Uint8Array([0xff, 0x00, 0xff, 0x00]),
            new TextEncoder().encode('中文😀\n"\\\ud800Hello, 世界! 🚀'),
        ];
        for (const sample of boundaryPairs) {
            expect(diagnosticDigest(sample)).toBe(referenceBigIntDigest(sample));
        }

        for (let len = 0; len <= 512; len++) {
            const buf = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                buf[i] = (i * 131 + len * 17) & 0xff;
            }
            expect(diagnosticDigest(buf)).toBe(referenceBigIntDigest(buf));
        }

        // Deterministic xorshift32 PRNG covering thousands of carry/boundary inputs
        let state = 0x12345678;
        const nextByte = () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) & 0xff;
        };
        for (let trial = 0; trial < 4000; trial++) {
            const len = (trial % 64) + 1;
            const buf = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                buf[i] = nextByte();
            }
            expect(diagnosticDigest(buf)).toBe(referenceBigIntDigest(buf));
        }
    });
});
