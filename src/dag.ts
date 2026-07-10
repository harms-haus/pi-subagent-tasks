/**
 * Pure DAG helpers for pi-task-pools.
 *
 * Every function here is PURE: no I/O, no globals, deterministic output. They
 * operate over the minimal structural shape a task exposes for dependency
 * resolution ({@link DagInput}); the full {@link TaskSpec} from `types.ts` is a
 * structural superset (its `id`/`title`/`dependsOn` align exactly), so resolved
 * task specs may be passed straight through.
 *
 *   §6.1  id assignment + dependsOn resolution by id OR title (kanban-style)
 *   §7.3  priority = transitive downstream dependent count (computed once)
 *
 * Consumed as a pipeline at pool creation:
 *   resolveDeps → detectCycles → topoSort / computeDownstreamCount
 */

// ── Input shape (§6.1) ───────────────────────────────────────────────────────

/**
 * Minimal structural input for dependency resolution. Any object exposing
 * optional `id`/`title`/`dependsOn` — notably the full `TaskSpec` — satisfies
 * this type.
 */
export interface DagInput {
  /** Optional id; else assigned `t-<N>`. Referenced by `dependsOn`. */
  id?: string;
  /** Optional human label; may be referenced by `dependsOn` as a title. */
  title?: string;
  /** Ids or titles of dependencies, resolved by {@link resolveDeps}. */
  dependsOn?: string[];
}

/** Result of {@link resolveDeps}. */
export interface ResolvedDeps {
  /** taskId → resolved dependency ids (empty array when a task has none). */
  idMap: Map<string, string[]>;
  /** Final task ids in declaration order (auto-assigned ids included). */
  assignedIds: string[];
}

// ── Id assignment ────────────────────────────────────────────────────────────

/**
 * Resolve a single task's id: its own `id` when present, else `t-<N>` where `N`
 * is its 1-based position in the declaration list (§6.1).
 */
function idFor(task: DagInput, index: number): string {
  return task.id ?? `t-${index + 1}`;
}

// ── Id assignment + dependency resolution (§6.1) ─────────────────────────────

/**
 * Assign ids and resolve `dependsOn` references (§6.1).
 *
 * 1. Each task missing an `id` is assigned `t-<N>` (1-based position). Tasks
 *    carrying their own id keep it.
 * 2. Duplicate ids — whether user-supplied or auto-assigned — throw.
 * 3. Each `dependsOn` entry is resolved: if it equals an existing task id it is
 *    kept verbatim; otherwise it is treated as a TITLE and mapped to the task
 *    whose title matches (id takes precedence over a like-named title). An entry
 *    matching neither an id nor a title throws, naming the unresolved ref and
 *    listing the known ids + titles. Duplicate resolutions are collapsed.
 *
 * @returns the resolved dependency map and the id list, both in declaration order.
 */
export function resolveDeps(tasks: DagInput[]): ResolvedDeps {
  const assignedIds: string[] = [];
  const idSet = new Set<string>();
  const titleToId = new Map<string, string>();

  // Pass 1: assign ids (1-based position), index titles, detect duplicates,
  // and validate user-supplied ids (§6.1 — path-traversal guard).
  for (const [i, task] of tasks.entries()) {
    // Validate user-supplied id: must be alphanumeric with dashes/underscores.
    // Auto-assigned ids (t-<N>) are always safe so we only check task.id.
    if (task.id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(task.id)) {
      throw new Error(
        `Task id must be alphanumeric with dashes/underscores only; got: "${task.id}"`,
      );
    }
    const id = idFor(task, i);
    if (idSet.has(id)) {
      throw new Error(`Duplicate task id "${id}" — task ids must be unique.`);
    }
    idSet.add(id);
    assignedIds.push(id);
    if (task.title !== undefined) {
      if (titleToId.has(task.title)) {
        throw new Error(
          `Duplicate task title "${task.title}" — titles referenced from dependsOn must be unique.`,
        );
      }
      titleToId.set(task.title, id);
    }
  }

  // Pass 2: resolve dependsOn (id first, else title) per task.
  const idMap = new Map<string, string[]>();
  for (const [i, task] of tasks.entries()) {
    const taskId = assignedIds[i] as string;
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const ref of task.dependsOn ?? []) {
      const mapped = titleToId.get(ref);
      const depId = idSet.has(ref) ? ref : mapped;
      if (depId === undefined) {
        const knownIds = [...idSet].join(", ") || "(none)";
        const knownTitles = [...titleToId.keys()].join(", ") || "(none)";
        throw new Error(
          `Task "${taskId}" depends on unresolved ref "${ref}". ` +
            `Known ids: ${knownIds}. Known titles: ${knownTitles}.`,
        );
      }
      if (!seen.has(depId)) {
        seen.add(depId);
        resolved.push(depId);
      }
    }
    idMap.set(taskId, resolved);
  }

  return { idMap, assignedIds };
}

// ── Cycle detection (DFS) ────────────────────────────────────────────────────

/**
 * Detect a dependency cycle via DFS (post-resolution validation, §6.1).
 *
 * Traverses only edges whose target is in `taskIds` (unknown refs are skipped to
 * avoid spurious cycles). On finding a node already on the current DFS stack, it
 * returns the cycle as a `" → "`-joined path (e.g. `"A → B → A"`). Acyclic input
 * yields `null`.
 *
 * @returns the cycle path string, or `null` when the graph is acyclic.
 */
export function detectCycles(taskIds: string[], deps: Map<string, string[]>): string | null {
  const idSet = new Set(taskIds);
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  const dfs = (node: string): string | null => {
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const dep of deps.get(node) ?? []) {
      if (!idSet.has(dep)) continue; // skip unknown refs
      if (inStack.has(dep)) {
        const start = path.indexOf(dep);
        return [...path.slice(start), dep].join(" → ");
      }
      if (!visited.has(dep)) {
        const found = dfs(dep);
        if (found !== null) return found;
      }
    }
    inStack.delete(node);
    path.pop();
    return null;
  };

  for (const start of taskIds) {
    if (!visited.has(start)) {
      const found = dfs(start);
      if (found !== null) return found;
    }
  }
  return null;
}

// ── Topological sort (Kahn's, stable) ────────────────────────────────────────

/**
 * Topologically order `taskIds` so every node follows its dependencies (§6.1).
 *
 * Uses Kahn's algorithm with a FIFO queue seeded in declaration order: siblings
 * unblocked at the same step preserve their relative declaration order. Should a
 * cycle leave nodes unordered, they are appended in declaration order so the
 * result is always a permutation of `taskIds` (cycles are caller-detected via
 * {@link detectCycles}).
 *
 * @returns the task ids in dependency-respecting, stable order.
 */
export function topoSort(taskIds: string[], deps: Map<string, string[]>): string[] {
  const idSet = new Set(taskIds);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of taskIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  // in-degree[node] = number of in-graph deps; dependents[dep] = nodes needing it.
  for (const id of taskIds) {
    const seen = new Set<string>();
    for (const dep of deps.get(id) ?? []) {
      if (!idSet.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dep)?.push(id);
    }
  }

  // FIFO queue seeded in declaration order for stability.
  const queue: string[] = [];
  for (const id of taskIds) {
    if ((inDegree.get(id) ?? 0) === 0) queue.push(id);
  }

  const result: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as string;
    result.push(node);
    for (const dependent of dependents.get(node) ?? []) {
      const deg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, deg);
      if (deg === 0) queue.push(dependent);
    }
  }

  // Append any cyclic leftovers in declaration order (completeness).
  if (result.length < taskIds.length) {
    const done = new Set(result);
    for (const id of taskIds) {
      if (!done.has(id)) result.push(id);
    }
  }
  return result;
}

// ── Transitive downstream count (priority key, §7.3) ─────────────────────────

/**
 * Count each task's UNIQUE transitive downstream dependents (§7.3 priority key).
 *
 * Builds the reverse adjacency (every one of a task's deps gains the task as a
 * direct dependent), then for each task traverses that reverse graph counting
 * every reachable descendant exactly once. A task with more downstream
 * dependents has higher priority: more tasks unblock when it completes. Ties
 * fall back to declaration order (handled by the caller, not here).
 *
 * @returns Map taskId → transitive downstream dependent count.
 */
export function computeDownstreamCount(
  taskIds: string[],
  deps: Map<string, string[]>,
): Map<string, number> {
  const idSet = new Set(taskIds);
  const dependents = new Map<string, Set<string>>();
  for (const id of taskIds) dependents.set(id, new Set());

  for (const id of taskIds) {
    for (const dep of deps.get(id) ?? []) {
      if (!idSet.has(dep)) continue;
      dependents.get(dep)?.add(id);
    }
  }

  const result = new Map<string, number>();
  for (const id of taskIds) {
    const visited = new Set<string>();
    const visit = (node: string): void => {
      for (const next of dependents.get(node) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        visit(next);
      }
    };
    visit(id);
    result.set(id, visited.size);
  }
  return result;
}
