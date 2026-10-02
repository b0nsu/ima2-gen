function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createQuitCleanup({ logger = console } = {}) {
  const tasks = new Map();
  let committed = false;
  const runOne = (name, fn) => {
    try {
      fn();
    } catch (error) {
      logger.error(`[desktop] quit cleanup ${name} failed: ${errorMessage(error)}`);
    }
  };

  return {
    get committed() { return committed; },
    register(name, fn) {
      if (committed) runOne(name, fn);
      else tasks.set(name, fn);
    },
    run() {
      if (committed) return;
      committed = true;
      for (const [name, fn] of tasks) runOne(name, fn);
      tasks.clear();
    },
  };
}
