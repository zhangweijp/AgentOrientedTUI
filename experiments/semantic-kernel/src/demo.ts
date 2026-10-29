import { createSession } from './kernel.js';
import { TaskRepository, openTaskView } from './task-app.js';

const repository = new TaskRepository([
  { id: 'task-a', title: '修复登录超时' },
  { id: 'task-b', title: '补充 API 文档' },
]);
const session = createSession();
openTaskView(session, repository, 'inbox');

try {
  const observation = session.observe();
  const first = observation.views[0]!.items[0]!;
  repository.reorder(['task-b', 'task-a']);
  const command = {
    observationId: observation.id,
    actionBindingId: first.actions[0]!.bindingId,
    invocationId: 'demo-complete-a',
    input: {},
  };
  const completion = await session.execute(command);
  const duplicate = await session.execute(command);
  const next = session.observe();
  const remaining = next.views[0]!.items.find(item => item.target.id === 'task-b')!;
  repository.rename('task-b', '文档已被其他操作者修改');
  const conflict = await session.execute({
    observationId: next.id,
    actionBindingId: remaining.actions[0]!.bindingId,
    invocationId: 'demo-stale-b',
    input: {},
  });
  console.log(JSON.stringify({ completion, duplicate, conflict, actualTasks: repository.list(), writes: repository.writes }, null, 2));
} finally {
  await session.close();
  console.log(JSON.stringify({ afterClose: session.inspect().activeCalls, subscriptions: repository.listenerCount }));
}
