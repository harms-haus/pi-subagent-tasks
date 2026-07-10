/**
 * Concurrency-pool coordinator — the 3-pool AND-gated accounting core (§5.3, §7).
 *
 * Three independent pools are maintained:
 *   - `total`  — whole-pool cap;
 *   - `provider[<provider>]` — counts every session using that provider,
 *     regardless of model;
 *   - `model["<provider>/<model>"]` — that exact provider/model combination.
 *
 * A session using `anthropic/claude-sonnet-4-5` consumes 1 from `total`, 1 from
 * `provider.anthropic`, and 1 from `model["anthropic/claude-sonnet-4-5"]`. An
 * agent may start **iff every applicable pool has room** (AND-semantics).
 *
 * CRITICAL design property — the acquire is **all-or-nothing**: either every
 * applicable pool is incremented, or none of them are. This breaks the
 * hold-and-wait condition from Coffman's four necessary conditions for
 * deadlock, so the system is deadlock-free by construction. (Node is
 * single-threaded, so this synchronous check-then-act is atomic — no async
 * mutex is required.)
 *
 * A pool that isn't configured is unlimited and never consulted.
 *
 * See the extension spec: §5.3 (3-pool model), §7 (pools state).
 */

import type { LimitsConfig, PoolSlot, PoolUsage } from "./types";

/**
 * Injectable coordinator the scheduler consults for slot accounting (§7). The
 * scheduler calls {@link PoolCoordinator.tryAcquire} before starting an agent
 * and {@link PoolCoordinator.release} when one finishes.
 */
export interface PoolCoordinator {
  /**
   * All-or-nothing acquire (§5.3 AND-semantics). If every applicable pool has
   * room, increment them all and return true; otherwise mutate nothing and
   * return false.
   */
  tryAcquire(provider?: string, model?: string): boolean;
  /** Release one unit from every applicable pool (guarded ≥ 0); wakes waiters. */
  release(provider?: string, model?: string): void;
  /** True iff every applicable pool currently has room (used < cap). */
  hasRoom(provider?: string, model?: string): boolean;
  /**
   * Snapshot of live usage across all three pools. Lazy: a configured
   * provider/model limit that has never been acquired still reports its cap
   * with `used: 0`; only entries present in the config are reported.
   */
  usage(): PoolUsage;
  /**
   * Wake-up hook invoked after every {@link release}. No-op by default; the
   * scheduler re-runs its scheduling pass around `release`, but may reassign
   * this to plug in a custom wake-up.
   *
   * This is an intentional extensibility hook: the scheduler drives its own
   * scheduling pass on every state mutation and does NOT rely on this hook,
   * so it is a no-op in the default `createPoolCoordinator` construction.
   * It exists for custom coordinators that want push-style wake-ups.
   */
  wakeWaiters(): void;
}

/**
 * Create a {@link PoolCoordinator} from a {@link LimitsConfig}. Provider and
 * model pools are created lazily: a configured entry that has never been
 * touched still reports its cap (used 0) via {@link PoolCoordinator.usage}.
 */
export function createPoolCoordinator(
  config: LimitsConfig,
  opts?: { wakeWaiters?: () => void },
): PoolCoordinator {
  const total: PoolSlot = { used: 0, cap: config.total };
  const providerSlots = new Map<string, PoolSlot>();
  const modelSlots = new Map<string, PoolSlot>();

  /** Composite model key: `provider/model`, or the bare model when no provider. */
  const modelKeyFor = (provider: string | undefined, model: string | undefined): string =>
    provider ? `${provider}/${model}` : (model ?? "");

  /**
   * Build a snapshot of every configured entry in a config map, copying values
   * defensively so the returned records are independent of live PoolSlot objects.
   */
  const snapshotSlots = (
    configMap: Record<string, number>,
    liveMap: Map<string, PoolSlot>,
  ): Record<string, PoolSlot> => {
    const result: Record<string, PoolSlot> = {};
    for (const [key, cap] of Object.entries(configMap)) {
      const slot = liveMap.get(key);
      result[key] = slot ? { used: slot.used, cap: slot.cap } : { used: 0, cap };
    }
    return result;
  };

  /** Lazily fetch-or-create the configured provider slot (undefined if unlimited). */
  const providerSlot = (provider: string): PoolSlot | undefined => {
    const cap = config.provider[provider];
    if (cap === undefined) return undefined; // unconfigured → unlimited
    const existing = providerSlots.get(provider);
    if (existing) return existing;
    const slot: PoolSlot = { used: 0, cap };
    providerSlots.set(provider, slot);
    return slot;
  };

  /** Lazily fetch-or-create the configured model slot (undefined if unlimited). */
  const modelSlot = (key: string): PoolSlot | undefined => {
    if (!key) return undefined; // empty key → unconfigured
    const cap = config.model[key];
    if (cap === undefined) return undefined; // unconfigured → unlimited
    const existing = modelSlots.get(key);
    if (existing) return existing;
    const slot: PoolSlot = { used: 0, cap };
    modelSlots.set(key, slot);
    return slot;
  };

  /** The applicable pools for a (provider, model) acquire/release, in fixed order. */
  const applicable = (provider: string | undefined, model: string | undefined): PoolSlot[] => {
    const pools: PoolSlot[] = [total];
    if (provider !== undefined) {
      const ps = providerSlot(provider);
      if (ps) pools.push(ps);
    }
    const ms = modelSlot(modelKeyFor(provider, model));
    if (ms) pools.push(ms);
    return pools;
  };

  const coordinator: PoolCoordinator = {
    tryAcquire(provider, model): boolean {
      const pools = applicable(provider, model);
      // all-or-nothing: check EVERY pool first, then mutate only if all fit.
      if (!pools.every((p) => p.used < p.cap)) return false;
      for (const p of pools) p.used += 1;
      return true;
    },

    release(provider, model): void {
      for (const p of applicable(provider, model)) {
        if (p.used > 0) p.used -= 1;
      }
      coordinator.wakeWaiters();
    },

    hasRoom(provider, model): boolean {
      return applicable(provider, model).every((p) => p.used < p.cap);
    },

    usage(): PoolUsage {
      return {
        total: { used: total.used, cap: total.cap },
        provider: snapshotSlots(config.provider, providerSlots),
        model: snapshotSlots(config.model, modelSlots),
      };
    },

    /**
     * Wake-up hook invoked after every {@link release}. Defaults to the
     * constructor-injected `opts.wakeWaiters` (if provided) or a no-op.
     */
    wakeWaiters:
      opts?.wakeWaiters ??
      ((): void => {
        // no-op by default; the scheduler re-runs its scheduling pass around
        // `release`. Reassign to plug in a custom wake-up (see release above).
      }),
  };

  return coordinator;
}
