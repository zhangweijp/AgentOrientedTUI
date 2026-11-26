/** Driver-neutral Runtime presentation resources. */
export { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from './system-instruction.js';
export { buildPublicToolName, DESKTOP_TOOL_NAMES } from './public-tool-name.js';
export { buildViewMessageMarkup, collapsedWindowText, escapeXmlText } from './view-message.js';
export { fitWindowPresentation, type WindowPresentation, type WindowRequestCost } from './window-budget.js';
export { NATIVE_REF_ADDRESS_SCHEMA, NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, projectNativeToolSchema, type PresentedRef } from './tool-projection.js';
export { projectDesktop, routeNativeInvocation, inspectRefSchema, type DesktopCapability, type NativeTool,
    type PresentedAppWindows, type ViewPresentation } from './desktop-presentation.js';
