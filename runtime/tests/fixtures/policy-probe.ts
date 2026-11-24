import type { AppInteractionPolicy } from '@aotui/core';
import { projectCompleteViews } from '@aotui/core/host';

export function policyProbe() {
    let rules: AppInteractionPolicy = { project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true };
    return {
        policy: {
            project: context => rules.project(context), authorize: context => rules.authorize(context),
            canReadReceipt: (metadata, signal) => rules.canReadReceipt(metadata, signal),
        } satisfies AppInteractionPolicy,
        use(policy: AppInteractionPolicy) { rules = policy; },
    };
}
