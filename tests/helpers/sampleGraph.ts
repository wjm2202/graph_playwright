/** Shared sample process graphs (Salesforce → Siebel SoD flow) for specs.
 *  goodGraph() = the v1 activity-node form (converter + compat tests).
 *  goodGraphV2() = the v2 state-node/relation-edge form — matches the shipped
 *  seed journeys/graphs/expense_to_siebel.graph.json (drift-guarded). */
import type { ProcessGraph } from '../../src/graph/schema';

export const goodGraphV2 = (): ProcessGraph => ({
  schema: 'process-graph/2',
  id: 'expense_to_siebel',
  title: 'Expense flows into Siebel',
  systems: {
    sf: { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' },
    siebel: { label: 'Siebel', kind: 'siebel', urlEnv: 'SIEBEL_URL', sessionPolicy: { maxConcurrent: 1 } },
  },
  actors: { submitter: 'sales_user', approver: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    {
      id: 'sess_sf_sales', type: 'session', label: 'Salesforce · submitter',
      system: 'sf', actor: 'submitter', account: { usernameEnv: 'SF_SALES_USERNAME' },
    },
    {
      id: 'sess_sf_admin', type: 'session', label: 'Salesforce · approver',
      system: 'sf', actor: 'approver', account: { usernameEnv: 'SF_ADMIN_USERNAME' },
    },
    {
      id: 'sess_siebel_admin', type: 'session', label: 'Siebel · approver',
      system: 'siebel', actor: 'approver', account: { usernameEnv: 'SIEBEL_ADMIN_USERNAME' },
      snapshot: { status: 'planned' },
    },
    {
      id: 'expense', type: 'data', label: 'Expense record',
      expects: [
        { id: 'expense_saved', kind: 'api.record_exists', target: 'Expense__c', after: 'expense.submit', note: 'expense row persisted' },
        { id: 'expense_approved', kind: 'api.field_equals', target: 'Expense__c', value: 'Status__c=Approved', after: 'expense.approve' },
      ],
    },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'sess_sf_sales', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'e2', from: 'sess_sf_sales', to: 'expense', type: 'does', label: 'submit expense', data: { catalog: 'expense.submit' } },
    { id: 'e3', from: 'sess_sf_sales', to: 'expense', type: 'denied', data: { capability: 'expense.approve' } },
    { id: 'e4', from: 'sess_sf_sales', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'e5', from: 'sess_sf_admin', to: 'expense', type: 'does', label: 'approve expense', data: { catalog: 'expense.approve', deltaMs: 1200 } },
    { id: 'e6', from: 'sess_sf_admin', to: 'sess_siebel_admin', type: 'login_as', data: { auth: 'ui' } },
    { id: 'e7', from: 'sess_siebel_admin', to: 'expense', type: 'does', label: 'verify expense', data: { catalog: 'siebel.verify_expense' } },
    { id: 'e8', from: 'sess_siebel_admin', to: 'end', type: 'next' },
  ],
});

export const goodGraph = (): ProcessGraph => ({
  schema: 'process-graph/1',
  id: 'expense_to_siebel',
  title: 'Expense flows into Siebel',
  systems: {
    sf: { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' },
    siebel: { label: 'Siebel', kind: 'siebel', urlEnv: 'SIEBEL_URL', sessionPolicy: { maxConcurrent: 1 } },
  },
  actors: { submitter: 'sales_user', approver: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    {
      id: 'submit', type: 'action', label: 'Submit expense', system: 'sf', actor: 'submitter',
      account: { usernameEnv: 'SF_SALES_USERNAME' }, catalog: 'expense.submit',
      steps: { status: 'planned' }, timing: { plannedMs: 30000 },
    },
    {
      id: 'approve', type: 'action', label: 'Approve', system: 'sf', actor: 'approver',
      snapshot: { status: 'planned' },
    },
    { id: 'verify', type: 'action', label: 'Verify in Siebel', system: 'siebel', actor: 'approver' },
    { id: 'done', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'submit', type: 'next' },
    { id: 'e2', from: 'submit', to: 'approve', type: 'next', data: { deltaMs: 1200 } },
    { id: 'e3', from: 'submit', to: 'approve', type: 'deny', data: { capability: 'expense.approve' } },
    { id: 'e4', from: 'approve', to: 'verify', type: 'handoff', data: { recordRef: 'a03xx0000012AbCDEF' } },
    { id: 'e5', from: 'verify', to: 'done', type: 'next' },
  ],
});
