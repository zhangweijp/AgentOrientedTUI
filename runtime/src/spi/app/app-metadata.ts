/** Author metadata shared by the generated manifest, factory and registration. */
export interface AppMetadata {
    readonly app_name: string;
    readonly description?: string;
    readonly whatItIs?: string;
    readonly whenToUse?: string;
}

/** Capture only metadata data properties, never application callbacks or accessors. */
export function captureAppMetadata(input: unknown): AppMetadata {
    const invalid = (path: string): never => { throw Object.assign(new TypeError(
        `APP_METADATA_INVALID: ${path} must be a data property; app_name must match /^[a-z0-9_]+$/ and descriptions must be strings`,
    ), { code: 'APP_METADATA_INVALID', path }); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('metadata');
    const fields = Object.getOwnPropertyDescriptors(input);
    const name = fields.app_name;
    if (!name || !('value' in name) || typeof name.value !== 'string' || !/^[a-z0-9_]+$/.test(name.value)) return invalid('app_name');
    const metadata: { app_name: string; description?: string; whatItIs?: string; whenToUse?: string } = { app_name: name.value };
    for (const key of ['description', 'whatItIs', 'whenToUse'] as const) {
        const field = fields[key];
        if (!field) continue;
        if (!('value' in field) || typeof field.value !== 'string') return invalid(key);
        metadata[key] = field.value;
    }
    return Object.freeze(metadata);
}
