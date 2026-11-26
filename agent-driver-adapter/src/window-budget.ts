import type { DrivenSourceContext, FittedModelRequest, MeasureModelRequest, ModelInputMeasurement } from '@aotui/agent-driver-v2';
import { DESKTOP_TOOL_NAMES, fitWindowPresentation, type WindowPresentation } from '@aotui/runtime/adapters';

export const BUDGET_TOOL = DESKTOP_TOOL_NAMES.readWindowBudget;
const ROWS_PER_PAGE = 4;
const TRIAL_REPORT_ID = '00000000-0000-0000-0000-000000000000';
export interface WindowCost {
    key: string;
    app_id: string;
    view_id?: string;
    presentation: 'body' | 'note' | 'hint' | 'omitted';
    bytes: number;
}
export interface BudgetNotice {
    reportId: string;
    full: ModelInputMeasurement;
}
export interface RenderedWindows {
    context: DrivenSourceContext;
    windows: readonly WindowCost[];
}
export interface WindowBudgetReport {
    readonly id: string;
    readonly summary: object;
    readonly rows: readonly object[];
}
export type WindowBudgetContent = Omit<WindowBudgetReport, 'id'>;

export function budgetHint(full: ModelInputMeasurement): string {
    return 'This View is open. Its body does not fit the current model request. Collapse or close other windows.\n' +
        `Estimated input cost using ${full.method}: ${full.estimated}. Available budget: ${full.inputLimit}.`;
}

export function budgetPage(report: WindowBudgetReport, page: number, inline = true) {
    const start = (page - 1) * ROWS_PER_PAGE;
    return { report_id: report.id, ...report.summary, ...(inline ? { page, windows: report.rows.slice(start, start + ROWS_PER_PAGE) } : {}),
        ...((!inline && report.rows.length) || start + ROWS_PER_PAGE < report.rows.length
            ? { next_page: inline ? page + 1 : 1 } : {}) };
}

const sum = (windows: readonly WindowCost[]) => windows.reduce((total, window) => total + window.bytes, 0);

export async function fitModelWindows(
    full: RenderedWindows,
    render: (presentation: WindowPresentation, notice?: BudgetNotice, includeReportTool?: boolean) => RenderedWindows,
    previous: ReadonlyMap<string, { bodyBytes?: number; restoreBody?: true }>,
    measure: MeasureModelRequest,
    includeFeedback: boolean,
    locate: (report: WindowBudgetContent) => { id: string; check(): void; retain(): void },
    requiredBodies?: ReadonlySet<string>,
): Promise<FittedModelRequest> {
    const original = await measure(full.context);
    if (original.estimated <= original.inputLimit) return { measurement: original };

    const fullLayout: WindowPresentation = { hints: new Set(), managementOnly: false };
    // A recovery request carries the report tool even when this is the first report.
    const fullCost = Object.hasOwn(full.context.tools, BUDGET_TOOL) ? original
        : await measure(render(fullLayout, undefined, true).context);
    const notice = { reportId: TRIAL_REPORT_ID, full: fullCost };
    const keepBodies = new Set(requiredBodies);
    for (const window of full.windows) if (previous.get(window.key)?.restoreBody) keepBodies.add(window.key);
    const candidates = full.windows.filter(window => {
        const old = previous.get(window.key)?.bodyBytes;
        return window.presentation === 'body' && (old === undefined || old < window.bytes);
    });
    const listed = render({ hints: new Set(candidates.map(row => row.key)), managementOnly: false }, notice);
    const hinted = new Map(listed.windows.map(row => [row.key, row]));
    const replaceable = candidates.filter(row => (hinted.get(row.key)?.bytes ?? Infinity) < row.bytes).map(row => row.key);
    const fullWindowBytes = sum(full.windows);
    const attempt = async (presentation: WindowPresentation) => {
        const next = render(presentation, notice);
        const current = new Map(next.windows.map(row => [row.key, row]));
        const currentBytes = sum(next.windows);
        const available = fullCost.inputLimit;
        const rows = full.windows.map(row => {
            const displayed = current.get(row.key);
            return { app_id: row.app_id, ...(row.view_id === undefined ? {} : { view_id: row.view_id }),
                full: row.bytes, presented: displayed?.bytes ?? 0, presentation: displayed?.presentation ?? 'omitted' };
        });
        const report = (cost: ModelInputMeasurement): WindowBudgetContent => ({
            summary: {
                method: fullCost.method, input_available: available, output_reserved: fullCost.outputReserved,
                complete: { estimated: fullCost.estimated, margin: fullCost.safety, window_bytes: fullWindowBytes },
                presented: { estimated: cost.estimated, margin: cost.safety, window_bytes: currentBytes },
                short_by: fullCost.estimated - available,
                mode: presentation.managementOnly ? 'management' : 'window_hints',
                actions: ['system-collapse_view', 'system-collapse_app', 'system-close_view', 'system-close_app']
                    .filter(name => Object.hasOwn(next.context.tools, name)),
            },
            rows,
        });
        let inline = true;
        let measurement = fullCost;
        if (includeFeedback) {
            for (const detail of [true, false]) {
                inline = detail;
                // Only the decimal counters in the feedback can change the next estimate.
                for (let pass = 0; pass < 8; pass++) {
                    const feedback = budgetPage({ id: notice.reportId, ...report(measurement) }, 1, inline);
                    const measured = await measure(next.context, feedback);
                    const unchanged = measured.estimated === measurement.estimated && measured.safety === measurement.safety;
                    measurement = measured;
                    if (unchanged) break;
                }
                if (measurement.estimated <= measurement.inputLimit || !rows.length) break;
            }
        } else measurement = await measure(next.context);
        return { presentation, measurement, report: report(measurement), inline };
    };
    const selected = await fitWindowPresentation<Awaited<ReturnType<typeof attempt>> | { measurement: ModelInputMeasurement }>(
        { measurement: fullCost }, replaceable, attempt, { keepBodies, requireBodies: requiredBodies !== undefined });
    if (!('presentation' in selected)) return selected;
    const { presentation, measurement, report, inline } = selected;
    if (requiredBodies || (!includeFeedback && measurement.estimated > measurement.inputLimit)) {
        return { measurement, ...(includeFeedback ? { feedback: budgetPage({ id: notice.reportId, ...report }, 1, inline) } : {}) };
    }
    const located = locate(report);
    const next = render(presentation, { ...notice, reportId: located.id });
    const feedback = includeFeedback ? budgetPage({ id: located.id, ...report }, 1, inline) : undefined;
    const context: DrivenSourceContext = { ...next.context, adopt: async () => {
        located.check();
        await next.context.adopt?.();
        located.retain();
    } };
    return { context, measurement: await measure(next.context, feedback), ...(feedback ? { feedback } : {}), retainFeedback: located.retain };
}
