import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class Activity extends EventEmitter {
  constructor(clock = Date.now) { super(); this.clock = clock; this.items = new Map(); }
  begin({ projectId, memberId = 'codex', taskId, title, detail = '' }) {
    const id = randomUUID();
    this.items.set(id, { id, projectId, memberId, taskId, title, detail: detail.slice(0, 180), status: 'running', startedAt: this.clock(), expiresAt: this.clock() + 90000 });
    this.emit('change'); return id;
  }
  finish(id, error) {
    const item = this.items.get(id); if (!item) return;
    Object.assign(item, { status: error ? 'error' : 'done', detail: error?.message?.slice(0, 180) || item.detail, expiresAt: this.clock() + (error ? 12000 : 2000) });
    this.emit('change');
  }
  report(projectId, { title, detail = '', finished = false, taskId }) {
    let item = [...this.items.values()].find(v => v.projectId === projectId && v.source === 'coordinator-report');
    if (finished) { if (item) this.finish(item.id); return item?.id || null; }
    if (!item || item.expiresAt <= this.clock()) { const id = this.begin({projectId, taskId, title, detail}); item = this.items.get(id); item.source = 'coordinator-report'; }
    Object.assign(item, { taskId, title, detail:detail.slice(0,180), status:'running', expiresAt:this.clock()+30000 });
    this.emit('change'); return item.id;
  }
  snapshot() {
    for (const [id, item] of this.items) if (item.expiresAt <= this.clock()) this.items.delete(id);
    return structuredClone([...this.items.values()]);
  }
}

export async function track(store, info, action) {
  const id = store.activity.begin(info);
  try { const result = await action(); store.activity.finish(id); return result; }
  catch (error) { store.activity.finish(id, error); throw error; }
}
