/**
 * App Launch Configuration
 * 
 * Passed to AppKernel during initialization.
 * [RFC-026] Now supports index signature for env vars injection
 */
export interface AppLaunchConfig {
    /** Host-owned persistence namespace, independent of canonical App name and execution identity. */
    AOTUI_APP_KEY?: string;
    [key: string]: unknown;
}
