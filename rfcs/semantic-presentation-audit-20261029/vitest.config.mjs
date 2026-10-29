import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default {
  root,
  resolve: {
    alias: {
      '@aotui/agent-driver-v2': root + 'agent-driver-v2/src/index.ts',
      preact: root + 'sdk/node_modules/preact',
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'rfcs/semantic-presentation-audit-20261029/probe.test.ts',
      'runtime/src/adapters/semantic-aotui-driven-source.test.ts',
    ],
    fileParallelism: false,
  },
};
