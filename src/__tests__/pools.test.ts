import { describe, it, expect, vi } from "vitest";

import { createPoolCoordinator } from "../pools";
import type { LimitsConfig, PoolUsage } from "../types";

/** LimitsConfig with just a total cap (no provider/model limits). */
const totalOnly = (total: number): LimitsConfig => ({ total, provider: {}, model: {} });

// ── single total pool: acquire / release ─────────────────────────────────────

describe("single total pool", () => {
  it("acquires up to the cap then refuses", () => {
    const c = createPoolCoordinator(totalOnly(2));
    expect(c.tryAcquire()).toBe(true);
    expect(c.tryAcquire()).toBe(true);
    expect(c.tryAcquire()).toBe(false); // cap exhausted
    expect(c.usage().total).toEqual({ used: 2, cap: 2 });
  });

  it("release frees a slot and allows another acquire", () => {
    const c = createPoolCoordinator(totalOnly(1));
    expect(c.tryAcquire()).toBe(true);
    expect(c.hasRoom()).toBe(false);
    c.release();
    expect(c.hasRoom()).toBe(true);
    expect(c.usage().total).toEqual({ used: 0, cap: 1 });
    expect(c.tryAcquire()).toBe(true);
  });

  it("release never decrements below zero", () => {
    const c = createPoolCoordinator(totalOnly(2));
    c.release(); // nothing acquired yet
    c.release();
    expect(c.usage().total).toEqual({ used: 0, cap: 2 });
  });
});

// ── provider + model AND-gate ────────────────────────────────────────────────

describe("provider + model AND-gate", () => {
  const config: LimitsConfig = {
    total: 3,
    provider: { anthropic: 2 },
    model: { "anthropic/sonnet": 1 },
  };

  it("a successful acquire consumes all three applicable pools", () => {
    const c = createPoolCoordinator(config);
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    expect(c.usage().total).toEqual({ used: 1, cap: 3 });
    expect(c.usage().provider["anthropic"]).toEqual({ used: 1, cap: 2 });
    expect(c.usage().model["anthropic/sonnet"]).toEqual({ used: 1, cap: 1 });
  });

  it("fails when the MODEL pool is full (provider + total still have room)", () => {
    const c = createPoolCoordinator(config);
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true); // model cap 1
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(false); // model full
    // AND-gate: nothing incremented on failure
    expect(c.usage().total).toEqual({ used: 1, cap: 3 });
    expect(c.usage().provider["anthropic"]).toEqual({ used: 1, cap: 2 });
    expect(c.usage().model["anthropic/sonnet"]).toEqual({ used: 1, cap: 1 });
  });

  it("fails when the PROVIDER pool is full (model for a different model has room)", () => {
    const c = createPoolCoordinator({
      total: 5,
      provider: { anthropic: 2 },
      model: { "anthropic/sonnet": 1, "anthropic/opus": 1 },
    });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    expect(c.tryAcquire("anthropic", "opus")).toBe(true); // provider now full (2/2)
    expect(c.tryAcquire("anthropic", "haiku")).toBe(false); // provider full
    // nothing incremented
    expect(c.usage().provider["anthropic"]).toEqual({ used: 2, cap: 2 });
    expect(c.usage().model).not.toHaveProperty("anthropic/haiku");
  });

  it("mutates NOTHING on a failed acquire blocked by total (asserts provider/model counts unchanged)", () => {
    const c = createPoolCoordinator({
      total: 1,
      provider: { anthropic: 5 },
      model: { "anthropic/sonnet": 5 },
    });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true); // total now 1/1
    const before = c.usage();
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(false); // total full
    const after = c.usage();
    expect(after).toEqual(before);
    expect(after.total).toEqual({ used: 1, cap: 1 });
    expect(after.provider["anthropic"]).toEqual({ used: 1, cap: 5 });
    expect(after.model["anthropic/sonnet"]).toEqual({ used: 1, cap: 5 });
  });

  it("release restores all applicable pools", () => {
    const c = createPoolCoordinator(config);
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    c.release("anthropic", "sonnet");
    expect(c.usage().total).toEqual({ used: 0, cap: 3 });
    expect(c.usage().provider["anthropic"]).toEqual({ used: 0, cap: 2 });
    expect(c.usage().model["anthropic/sonnet"]).toEqual({ used: 0, cap: 1 });
  });
});

// ── hasRoom ──────────────────────────────────────────────────────────────────

describe("hasRoom", () => {
  it("is false when the total pool is full", () => {
    const c = createPoolCoordinator(totalOnly(1));
    expect(c.hasRoom()).toBe(true);
    expect(c.tryAcquire()).toBe(true);
    expect(c.hasRoom()).toBe(false);
  });

  it("reflects the binding (smallest applicable) pool", () => {
    const c = createPoolCoordinator({
      total: 10,
      provider: { openai: 1 },
      model: {},
    });
    expect(c.hasRoom("openai", "gpt-4")).toBe(true);
    expect(c.tryAcquire("openai", "gpt-4")).toBe(true);
    expect(c.hasRoom("openai", "gpt-4")).toBe(false); // provider full
    expect(c.hasRoom()).toBe(true); // total still has room
  });
});

// ── unconfigured provider/model = unlimited ─────────────────────────────────

describe("unconfigured pools are unlimited (not consulted)", () => {
  it("acquires regardless of provider/model when those pools are unconfigured", () => {
    const c = createPoolCoordinator(totalOnly(1));
    expect(c.tryAcquire("anthropic", "opus")).toBe(true); // only total applies
    expect(c.usage().provider).toEqual({});
    expect(c.usage().model).toEqual({});
  });

  it("an unconfigured model does not gate a configured provider", () => {
    const c = createPoolCoordinator({ total: 5, provider: { anthropic: 2 }, model: {} });
    // different model each time — no model limit applies, provider still gates
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    expect(c.tryAcquire("anthropic", "opus")).toBe(true);
    expect(c.tryAcquire("anthropic", "haiku")).toBe(false); // provider full
    expect(c.usage().provider["anthropic"]).toEqual({ used: 2, cap: 2 });
    expect(c.usage().model).toEqual({});
  });
});

// ── lazy usage reporting ─────────────────────────────────────────────────────

describe("lazy usage reporting", () => {
  it("reports configured caps with used 0 before any acquire", () => {
    const config: LimitsConfig = {
      total: 4,
      provider: { anthropic: 3, openai: 2 },
      model: { "anthropic/sonnet": 1 },
    };
    const c = createPoolCoordinator(config);
    const u: PoolUsage = c.usage();
    expect(u.total).toEqual({ used: 0, cap: 4 });
    expect(u.provider).toEqual({
      anthropic: { used: 0, cap: 3 },
      openai: { used: 0, cap: 2 },
    });
    expect(u.model).toEqual({ "anthropic/sonnet": { used: 0, cap: 1 } });
  });

  it("does not invent entries for unconfigured providers/models", () => {
    const c = createPoolCoordinator({ total: 2, provider: {}, model: {} });
    const u = c.usage();
    expect(u.provider).toEqual({});
    expect(u.model).toEqual({});
    expect(u.total).toEqual({ used: 0, cap: 2 });
  });

  it("returns independent snapshots (mutating the result does not affect state)", () => {
    const c = createPoolCoordinator(totalOnly(2));
    c.tryAcquire();
    const snap = c.usage();
    snap.total.used = 99;
    snap.total.cap = 99;
    expect(c.usage().total).toEqual({ used: 1, cap: 2 });
  });

  it("defensive copy on provider/model slots — mutating a snapshot does not corrupt internal state", () => {
    const c = createPoolCoordinator({
      total: 3,
      provider: { anthropic: 2 },
      model: { "anthropic/sonnet": 1 },
    });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);

    const snap = c.usage();
    // Mutate the snapshot aggressively
    snap.provider["anthropic"]!.used = 99;
    snap.provider["anthropic"]!.cap = 99;
    snap.model["anthropic/sonnet"]!.used = 99;
    snap.model["anthropic/sonnet"]!.cap = 99;

    // Internal state must be unchanged
    const fresh = c.usage();
    expect(fresh.total).toEqual({ used: 1, cap: 3 });
    expect(fresh.provider["anthropic"]).toEqual({ used: 1, cap: 2 });
    expect(fresh.model["anthropic/sonnet"]).toEqual({ used: 1, cap: 1 });
  });
});

// ── acquire-when-total-full returns false and mutates nothing ────────────────

describe("acquire when total full", () => {
  it("returns false and leaves every pool count unchanged", () => {
    const c = createPoolCoordinator({
      total: 1,
      provider: { anthropic: 9 },
      model: { "anthropic/sonnet": 9 },
    });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    const before = c.usage();
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(false);
    expect(c.usage()).toEqual(before);
  });
});

// ── modelKey composite format ────────────────────────────────────────────────

describe("modelKey composite format (provider/model)", () => {
  it("applies the model limit only when provider/model match exactly", () => {
    const c = createPoolCoordinator({
      total: 5,
      provider: {},
      model: { "anthropic/sonnet": 1 },
    });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true); // matches the key
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(false); // model full
    expect(c.usage().model["anthropic/sonnet"]).toEqual({ used: 1, cap: 1 });

    // a different model is unlimited (no matching model entry)
    expect(c.tryAcquire("anthropic", "opus")).toBe(true);
    expect(c.tryAcquire("anthropic", "opus")).toBe(true);
    expect(c.usage().model).not.toHaveProperty("anthropic/opus");
  });

  it("uses the bare model when no provider is given", () => {
    const c = createPoolCoordinator({
      total: 5,
      provider: {},
      model: { "some-model": 1 },
    });
    expect(c.tryAcquire(undefined, "some-model")).toBe(true);
    expect(c.tryAcquire(undefined, "some-model")).toBe(false);
    expect(c.usage().model["some-model"]).toEqual({ used: 1, cap: 1 });
  });
});

// ── provider-only limit (no model limit) ─────────────────────────────────────

describe("provider-only limit", () => {
  it("counts the provider but not the model", () => {
    const c = createPoolCoordinator({ total: 5, provider: { anthropic: 2 }, model: {} });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    const u = c.usage();
    expect(u.provider["anthropic"]).toEqual({ used: 1, cap: 2 });
    expect(u.model).toEqual({}); // no model accounting
  });
});

// ── multiple acquires up to cap then false ───────────────────────────────────

describe("multiple acquires up to cap", () => {
  it("accepts `cap` acquires then refuses", () => {
    const c = createPoolCoordinator({ total: 10, provider: { anthropic: 3 }, model: {} });
    expect(c.tryAcquire("anthropic", "a")).toBe(true);
    expect(c.tryAcquire("anthropic", "b")).toBe(true);
    expect(c.tryAcquire("anthropic", "c")).toBe(true);
    expect(c.tryAcquire("anthropic", "d")).toBe(false); // provider cap 3
    expect(c.usage().provider["anthropic"]).toEqual({ used: 3, cap: 3 });
  });

  it("acquires stop at the smallest applicable cap", () => {
    const c = createPoolCoordinator({
      total: 10,
      provider: { anthropic: 4 },
      model: { "anthropic/x": 2 },
    });
    expect(c.tryAcquire("anthropic", "x")).toBe(true);
    expect(c.tryAcquire("anthropic", "x")).toBe(true);
    expect(c.tryAcquire("anthropic", "x")).toBe(false); // model cap 2 binds
    expect(c.usage().model["anthropic/x"]).toEqual({ used: 2, cap: 2 });
    expect(c.usage().provider["anthropic"]).toEqual({ used: 2, cap: 4 }); // not full
    expect(c.usage().total).toEqual({ used: 2, cap: 10 }); // not full
  });
});

// ── two models under one provider share provider slots ───────────────────────

describe("two models under one provider", () => {
  it("each session consumes a provider slot regardless of model", () => {
    const c = createPoolCoordinator({ total: 10, provider: { anthropic: 2 }, model: {} });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true); // provider 1/2
    expect(c.tryAcquire("anthropic", "opus")).toBe(true); // provider 2/2
    expect(c.tryAcquire("anthropic", "haiku")).toBe(false); // provider full
    expect(c.usage().provider["anthropic"]).toEqual({ used: 2, cap: 2 });
  });

  it("releasing one model frees a shared provider slot for the other", () => {
    const c = createPoolCoordinator({ total: 10, provider: { anthropic: 2 }, model: {} });
    expect(c.tryAcquire("anthropic", "sonnet")).toBe(true);
    expect(c.tryAcquire("anthropic", "opus")).toBe(true);
    expect(c.tryAcquire("anthropic", "haiku")).toBe(false); // full
    c.release("anthropic", "sonnet"); // free one
    expect(c.tryAcquire("anthropic", "haiku")).toBe(true); // now fits
  });
});

// ── wakeWaiters hook ─────────────────────────────────────────────────────────

describe("wakeWaiters", () => {
  it("is a no-op by default (calling release does not throw)", () => {
    const c = createPoolCoordinator(totalOnly(1));
    expect(() => {
      c.release();
    }).not.toThrow();
    expect(() => {
      c.wakeWaiters();
    }).not.toThrow();
  });

  it("is invoked on every release (scheduler may override it)", () => {
    const c = createPoolCoordinator(totalOnly(1));
    const wake = vi.fn();
    c.wakeWaiters = wake;
    c.release();
    c.release("anthropic", "sonnet");
    expect(wake).toHaveBeenCalledTimes(2);
  });
});
