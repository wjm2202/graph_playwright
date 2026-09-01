/**
 * Excel door for ado:import — an ADO "Export to Excel" (Test Plans) or a
 * query export saved as .xlsx becomes AdoCase[] through the SAME row parser
 * the CSV door uses (fromAdo.casesFromRows). SheetJS (devDependency `xlsx`)
 * is the only place it is imported, so fromAdo.ts stays dependency-free
 * for the planner build.
 *
 * Sheet choice: the first sheet whose grid has a Title header (ADO exports
 * sometimes put a cover sheet first); every cell is read as TEXT so ids
 * like 00Q… never become numbers.
 */
import * as XLSX from 'xlsx';
import { casesFromRows, parseAdoCsv, type AdoCase } from './fromAdo';

export interface ParsedWorkbook {
  cases: AdoCase[];
  sheet: string;
  /** Sheets that were looked at and skipped (no Title header). */
  skippedSheets: string[];
}

export function parseAdoXlsx(data: Buffer | Uint8Array): ParsedWorkbook {
  const wb = XLSX.read(data, { type: 'buffer', cellText: true, cellDates: false });
  const skipped: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
    const rows = grid.map((r) => r.map((c) => (typeof c === 'string' ? c : c === undefined || c === null ? '' : typeof c === 'number' || typeof c === 'boolean' ? String(c) : JSON.stringify(c))));
    if (!rows.slice(0, 20).some((r) => r.some((c) => /^\s*title\s*$/i.test(c)))) {
      skipped.push(name);
      continue;
    }
    return { cases: casesFromRows(rows), sheet: name, skippedSheets: skipped };
  }
  throw new Error(
    `ADO xlsx: no sheet with a 'Title' column (looked at: ${wb.SheetNames.join(', ') || 'none'}) — export the test cases from ADO with their steps`,
  );
}

/** One door for both file kinds, chosen by extension. */
export function parseAdoFile(filename: string, data: Buffer | Uint8Array): ParsedWorkbook {
  if (/\.xlsx?$|\.xlsm$/i.test(filename)) return parseAdoXlsx(data);
  const text = Buffer.from(data).toString('utf8').replace(/^﻿/, '');
  return { cases: parseAdoCsv(text), sheet: 'csv', skippedSheets: [] };
}
