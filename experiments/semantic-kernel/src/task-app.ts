import { z } from 'zod';
import { defineAction } from './kernel.js';
import type { Action, ActionContext, ActionResult, Session, Target } from './contracts.js';

export interface Task { readonly id: string; readonly title: string; readonly done: boolean; readonly revision: string }

/** Example business adapter; CAS is synchronous in a single JS event turn. */
export class TaskRepository {
  private readonly tasks = new Map<string, Task>();
  private order: string[] = [];
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  writes = 0;

  constructor(items: readonly { readonly id: string; readonly title: string }[]) {
    for (const item of items) this.put(item.id, item.title);
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
  private nextRevision(): string { return String(++this.revision); }

  list(): readonly Task[] { return this.order.map(id => this.tasks.get(id)!).map(task => ({ ...task })); }
  get(id: string): Task | undefined { const task = this.tasks.get(id); return task && { ...task }; }
  get listenerCount(): number { return this.listeners.size; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  put(id: string, title: string): void {
    if (!this.tasks.has(id)) this.order.push(id);
    this.tasks.set(id, { id, title, done: false, revision: this.nextRevision() });
    this.emit();
  }

  reorder(ids: readonly string[]): void {
    if (ids.length !== this.tasks.size || new Set(ids).size !== ids.length || ids.some(id => !this.tasks.has(id))) {
      throw new Error('reorder must preserve the exact identity set');
    }
    this.order = [...ids];
    this.emit();
  }

  rename(id: string, title: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} is missing`);
    this.tasks.set(id, { ...task, title, revision: this.nextRevision() });
    this.emit();
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.order = this.order.filter(value => value !== id);
    this.emit();
  }

  complete(context: ActionContext): ActionResult {
    const task = this.tasks.get(context.target.id);
    if (!task) return { status: 'rejected', code: 'NOT_FOUND', message: 'Task no longer exists.' };
    if (task.revision !== context.target.revision) {
      return { status: 'rejected', code: 'STALE_RESOURCE', message: 'Task changed after this observation; observe again.' };
    }
    if (task.done) return { status: 'rejected', code: 'ALREADY_DONE', message: 'Task is already complete.' };
    if (context.signal.aborted) return { status: 'rejected', code: 'ABORTED', message: 'Cancelled before the local write.' };
    const completed = { ...task, done: true, revision: this.nextRevision() };
    this.tasks.set(task.id, completed);
    this.writes++;
    this.emit();
    return { status: 'succeeded', value: { ...completed } };
  }

  target(task: Task): Target { return { kind: 'Task', id: task.id, revision: task.revision, data: { title: task.title, done: task.done } }; }
}

export function createTaskAction(repository: TaskRepository): Action {
  return defineAction({
    name: 'complete_task',
    description: 'Complete this observed task only if its version still matches.',
    input: z.strictObject({}),
    execute: context => repository.complete(context),
  });
}

export function openTaskView(session: Session, repository: TaskRepository, id: string, action = createTaskAction(repository)): () => Promise<void> {
  return session.openView({
    id,
    subscribe: repository.subscribe,
    project: () => repository.list().map(task => ({
      label: task.title,
      target: repository.target(task),
      actions: task.done ? [] : [action],
    })),
  });
}
