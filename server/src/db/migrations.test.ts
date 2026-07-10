import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const drizzleDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  const raw = fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/**
 * Invariants the drizzle migrator silently depends on. It applies a migration
 * only when the LAST APPLIED migration's created_at (taken from `when` at
 * apply time) is < the candidate's `when` — so a new migration whose `when`
 * is not strictly greater than every earlier one is SKIPPED on any database
 * that is already up to date, while fresh (test) databases apply everything
 * and notice nothing. That exact skew shipped once (hand-written 0006–0009
 * used future-dated `when`s; codegen'd 0010 got the real clock, sorted below
 * them, and production silently missed its columns) — this test makes the
 * next occurrence a local failure instead of a production incident.
 */
describe('drizzle migration journal', () => {
  it('has strictly increasing `when` timestamps in idx order', () => {
    const entries = readJournal().sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      expect(
        cur.when,
        `journal entry ${cur.tag} (when=${cur.when}) must have a larger \`when\` than ` +
          `${prev.tag} (when=${prev.when}) — otherwise already-migrated databases skip it`,
      ).toBeGreaterThan(prev.when);
    }
  });

  it('has a .sql file for every journal entry (and no stray idx gaps)', () => {
    const entries = readJournal().sort((a, b) => a.idx - b.idx);
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(
        fs.existsSync(path.join(drizzleDir, `${entry.tag}.sql`)),
        `missing migration file for journal entry ${entry.tag}`,
      ).toBe(true);
    });
  });
});
