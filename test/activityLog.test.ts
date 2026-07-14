import { describe, expect, it, vi } from 'vitest';
import { createActivityLog } from '../src/activity/activityLog.js';

function baseEntry() {
  return {
    toolName: 'render_dashboard',
    connectionId: 'conn1',
    dashboardUid: 'dash1',
    panelId: 1,
  };
}

describe('createActivityLog', () => {
  it('assigns an incrementing id and timestamp to each recorded entry', () => {
    const log = createActivityLog();
    log.record(baseEntry());
    log.record(baseEntry());
    const [first, second] = log.list();
    expect(first!.id).toBe('1');
    expect(second!.id).toBe('2');
    expect(typeof first!.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(first!.timestamp))).toBe(false);
  });

  it('list() returns entries in recorded order and is a snapshot copy', () => {
    const log = createActivityLog();
    log.record(baseEntry());
    const snapshot = log.list();
    log.record(baseEntry());
    expect(snapshot.length).toBe(1);
    expect(log.list().length).toBe(2);
  });

  it('caps at maxEntries, dropping the oldest first', () => {
    const log = createActivityLog(3);
    log.record({ ...baseEntry(), panelId: 1 });
    log.record({ ...baseEntry(), panelId: 2 });
    log.record({ ...baseEntry(), panelId: 3 });
    log.record({ ...baseEntry(), panelId: 4 });
    const entries = log.list();
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.panelId)).toEqual([2, 3, 4]);
  });

  it('notifies onEntry listeners synchronously on record, and stops after unsubscribe', () => {
    const log = createActivityLog();
    const cb = vi.fn();
    const unsubscribe = log.onEntry(cb);
    log.record(baseEntry());
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toMatchObject({ dashboardUid: 'dash1' });
    unsubscribe();
    log.record(baseEntry());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('supports multiple independent listeners', () => {
    const log = createActivityLog();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    log.onEntry(cb1);
    log.onEntry(cb2);
    log.record(baseEntry());
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
