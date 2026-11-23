export interface WindowRequestCost {
    readonly estimated: number;
    readonly inputLimit: number;
}

export interface WindowPresentation {
    readonly hints: ReadonlySet<string>;
    readonly managementOnly: boolean;
}

/** Try shorter presentations of the same captured request. The caller supplies final input costs. */
export async function fitWindowPresentation<T extends { readonly measurement: WindowRequestCost }>(
    full: T,
    candidates: readonly string[],
    measure: (presentation: WindowPresentation) => Promise<T>,
    options?: { readonly keepBodies: ReadonlySet<string>; readonly requireBodies?: boolean },
): Promise<T> {
    const fits = ({ measurement }: T) => measurement.estimated <= measurement.inputLimit;
    if (fits(full)) return full;

    const tryHints = async (eligible: readonly string[]): Promise<T> => {
        if (!eligible.length) return full;
        let hints = new Set(eligible);
        let best = await measure({ hints, managementOnly: false });
        if (!fits(best)) return best;
        for (const id of eligible) {
            const trial = new Set(hints);
            trial.delete(id);
            const result = await measure({ hints: trial, managementOnly: false });
            if (fits(result)) { hints = trial; best = result; }
        }
        return best;
    };
    const eligible = options ? candidates.filter(id => !options.keepBodies.has(id)) : candidates;
    const preferred = await tryHints(eligible);
    if (fits(preferred) || options?.requireBodies) return preferred;
    if (eligible.length !== candidates.length) {
        const fallback = await tryHints(candidates);
        if (fits(fallback)) return fallback;
    }
    return measure({ hints: new Set(), managementOnly: true });
}
