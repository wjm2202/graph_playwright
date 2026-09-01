/**
 * GENERATED for graph 'lead_to_customer' — SIMULATED placeholder vocabulary.
 * Written by `SIMULATE=lead_to_customer npm run simulate`; every entry THROWS on
 * use. Replace it with real captures: record each session
 * (RECORD_PERSONA=<persona> RECORD_JOURNEY=lead_to_customer npm run record), then
 * run the pipeline — its generated module overwrites this one.
 */
import type { StepCatalog, StepFn } from '../catalog';

export function registerSteps_lead_to_customer(catalog: StepCatalog): StepCatalog {
  return catalog
    .register('lead.create', simulated('lead.create'))
    .register('lead.progress_to_potential', simulated('lead.progress_to_potential'))
    .register('credit.check', simulated('credit.check'))
    .register('lead.approve_to_customer', simulated('lead.approve_to_customer'))
    .register('siebel.check_customer', simulated('siebel.check_customer'));
}

function simulated(name: string): StepFn {
  return () =>
    Promise.reject(
      new Error(`step '${name}' is a simulated placeholder — record the real flow and re-run the pipeline to implement it`),
    );
}
