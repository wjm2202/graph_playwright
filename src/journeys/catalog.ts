/**
 * Step catalog — the TypeScript vocabulary journeys are written in.
 * JSON stays small; selectors, waits, and component objects live here.
 *
 * Two registries:
 *  - steps:  "expense.submit"  → what an actor DOES
 *  - denies: "expense.approve" → how to PROVE an actor is refused
 *    (UI probe: control absent / refusal surfaced; API probe: server refuses).
 * Every deny capability must be registered — an unregistered deny is a spec
 * bug, never a vacuous pass.
 */

import type { Page } from '@playwright/test';
import { Lightning } from '../fixtures/test';
import type { Cast, DenyProbe } from '../fixtures/cast';
import type { RefMap } from '../data/seed';
import type { Journey } from './schema';

export interface StepCtx {
  page: Page;
  lightning: Lightning;
  cast: Pick<Cast, 'as' | 'deny'>;
  refs: RefMap;
  /** Step `with` args, placeholders already resolved. */
  args: Record<string, unknown>;
  /** Step `expect` block, placeholders already resolved. */
  expects: Record<string, unknown>;
  /** The seeding/query API when the runner has one (dual-layer assertions). */
  api?: unknown;
  journey: Journey;
  stepIndex: number;
}

export type StepFn = (ctx: StepCtx) => Promise<void>;

export interface DenyCtx {
  refs: RefMap;
  /** deny.target, placeholders resolved. */
  target: unknown;
  journey: Journey;
  stepIndex: number;
}

export type DenyProbeFactory = (ctx: DenyCtx) => DenyProbe;

export class StepCatalog {
  private readonly steps = new Map<string, StepFn>();
  private readonly denies = new Map<string, DenyProbeFactory>();

  register(name: string, fn: StepFn): this {
    if (this.steps.has(name)) throw new Error(`step '${name}' already registered`);
    this.steps.set(name, fn);
    return this;
  }

  registerDeny(capability: string, factory: DenyProbeFactory): this {
    if (this.denies.has(capability)) throw new Error(`deny probe '${capability}' already registered`);
    this.denies.set(capability, factory);
    return this;
  }

  step(name: string): StepFn {
    const fn = this.steps.get(name);
    if (!fn) {
      throw new Error(`unknown step '${name}' — catalog has: ${[...this.steps.keys()].join(', ') || '(empty)'}`);
    }
    return fn;
  }

  denyProbe(capability: string): DenyProbeFactory {
    const f = this.denies.get(capability);
    if (!f) {
      throw new Error(
        `no deny probe registered for '${capability}' — denials must be explicit, an unregistered capability can never vacuously pass. Registered: ${[...this.denies.keys()].join(', ') || '(none)'}`,
      );
    }
    return f;
  }

  stepNames(): string[] {
    return [...this.steps.keys()];
  }

  denyCapabilities(): string[] {
    return [...this.denies.keys()];
  }
}
