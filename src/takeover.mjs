export async function syncTakeovers(store, native) {
  for (const project of store.state.projects.filter(p => p.takeover?.active)) {
    const status = await native.call('takeover_status', { pid: project.takeover.pid });
    if (status.active === false) {
      project.takeover.active = false; project.takeover.endedAt = new Date().toISOString();
      store.addSystem(project, '人工接管已结束。项目保持暂停，恢复前请核实客户端状态。'); store.save();
    }
  }
}
