#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [currentArg, baselineArg] = process.argv.slice(2);
if (!currentArg || !baselineArg) {
    throw new Error('Usage: node summarize-view-type-tool-capacity.mjs <v3-samples-dir> <v2-samples-dir>');
}

const currentDir = resolve(currentArg);
const baselineDir = resolve(baselineArg);
const sampleCount = 5;
const viewCounts = [1, 10, 100, 1000];
const timingStages = ['viewMount', 'toolRegistration', 'commit', 'observe', 'invoke', 'cleanup'];
const keyStages = ['commit', 'observe', 'invoke'];

async function loadSamples(directory, expectedVersion) {
    const samples = [];
    for (let index = 1; index <= sampleCount; index++) {
        const path = join(directory, `sample-${index}.json`);
        const result = JSON.parse(await readFile(path, 'utf8'));
        if (result.version !== expectedVersion) {
            throw new Error(`${path} has version ${result.version}; expected ${expectedVersion}`);
        }
        if (result.cases?.length !== viewCounts.length) throw new Error(`${path} does not contain all four View counts`);
        samples.push(result);
    }
    return samples;
}

function nearestRank(values, percentile) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(percentile * sorted.length) - 1];
}

const [current, baseline] = await Promise.all([
    loadSamples(currentDir, 'view-type-v3'),
    loadSamples(baselineDir, 'view-owned-v2'),
]);
const comparisons = [];
for (const views of viewCounts) {
    const currentCases = current.map(sample => sample.cases.find(item => item.views === views));
    const baselineCases = baseline.map(sample => sample.cases.find(item => item.views === views));
    const timings = {};
    for (const stage of timingStages) {
        const currentValues = currentCases.map(item => item.timingsMs[stage]);
        const baselineValues = baselineCases.map(item => item.timingsMs[stage]);
        const currentP95Ms = nearestRank(currentValues, 0.95);
        const baselineP95Ms = nearestRank(baselineValues, 0.95);
        const differenceMs = currentP95Ms - baselineP95Ms;
        const allowedRegressionMs = Math.max(baselineP95Ms * 0.1, 2);
        timings[stage] = {
            currentSamplesMs: currentValues,
            baselineSamplesMs: baselineValues,
            currentNearestRankP95Ms: currentP95Ms,
            baselineNearestRankP95Ms: baselineP95Ms,
            differenceMs,
            ...(keyStages.includes(stage) ? {
                allowedRegressionMs,
                withinRegressionBudget: differenceMs <= allowedRegressionMs,
            } : {}),
        };
    }
    comparisons.push({
        views,
        registryToolRegistrationCalls: {
            current: currentCases.map(item => item.registryToolRegistrationCalls),
            baseline: baselineCases.map(item => item.registryToolRegistrationCalls),
        },
        snapshotToolDescriptors: {
            current: currentCases.map(item => item.snapshotToolDescriptors),
            baseline: baselineCases.map(item => item.snapshotToolDescriptors),
        },
        payloadBytes: {
            current: currentCases.map(item => ({ payloadBytes: item.payloadBytes, selectedObservation: item.selectedObservation })),
            baseline: baselineCases.map(item => ({ payloadBytes: item.payloadBytes, selectedObservation: item.selectedObservation })),
        },
        timings,
    });
}

console.log(JSON.stringify({
    benchmark: 'AOTUI Core View/Tool capacity and lifecycle comparison',
    samplesPerVersion: sampleCount,
    percentile: 'nearest-rank p95; with five independent samples this is the maximum sample',
    keyStageRegressionBudget: 'current p95 - baseline p95 <= max(10% of baseline p95, 2 ms)',
    sourceVersions: {
        current: current.map(sample => ({ node: sample.node, platform: sample.platform, arch: sample.arch })),
        baseline: baseline.map(sample => ({ node: sample.node, platform: sample.platform, arch: sample.arch })),
    },
    limitations: [
        'This compares Core Registry, Snapshot, and Observation stages only; it does not measure Worker, DOM, SDK definition-time, Host resolution, wire validation, rendered Messages, or model tokens.',
        'JSON byte measurements are component measurements and overlap; do not sum them. They are not serialized User Message sizes.',
        'Schema compiler call counts are source-derived by each sample; they are not profiler instrumentation and exclude SDK, Host, and Worker stages.',
    ],
    comparisons,
}, null, 2));
