import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/records/store';
import { listCachedMembers } from '../../src/taskproof/worker/memberCache';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { saveSession } from '../../src/taskproof/worker/session';
import { ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

describe('task-proof refresh mapped members', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function openDb(): Database.Database {
    const db = new Database(':memory:');
    configureSqliteConnection(db);
    initTables(db);
    initTaskproofTables(db);
    return db;
  }

  function port(): ZcaLoginPort {
    return {
      login: async () => undefined,
      loginQR: async () => ({ cookie: ['c'], imei: 'i', userAgent: 'ua' }),
      getOwnId: () => 'own-zca',
      getGroupInfo: async () => ({
        groupId: 'zca-1',
        name: 'Nhom A',
        currentMems: [
          { id: 'u1', dName: 'An' },
          { id: 'u2', dName: 'Binh' },
        ],
        totalMember: 2,
        hasMoreMember: false,
        memVerList: [],
        adminIds: [],
        creatorId: '',
        lockViewMember: false,
      }),
      getGroupMembersInfo: async (ids) => ids.map((id) => ({ id, displayName: id === 'u1' ? 'An' : 'Binh' })),
    };
  }

  it('refuses to refresh until the worker is logged in, then writes the group cache', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid)
       VALUES ('off_1', 'zca-1', NULL, 1, NULL)`
    ).run();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-refresh-'));
    tmpDirs.push(dir);
    const sessionPath = path.join(dir, 'session.json');
    const runtime = new WorkerRuntime({
      db,
      loginPort: port(),
      getSessionFilePath: () => sessionPath,
      scheduleTimeout: () => () => undefined,
      scheduleInterval: () => () => undefined,
    });

    const denied = await runtime.refreshMappedMembers();
    expect(denied).toMatchObject({ httpStatus: 409, error: 'not_listening', refreshed: [] });
    expect(listCachedMembers(db, 'zca-1')).toEqual([]);

    saveSession({ cookie: ['c'], imei: 'i', userAgent: 'ua' }, sessionPath);
    const login = await runtime.ensureListening();
    expect(login.state).toBe('reusing_session');

    const refreshed = await runtime.refreshMappedMembers();
    expect(refreshed.httpStatus).toBe(200);
    expect(refreshed.refreshed).toEqual([
      { zca_group_id: 'zca-1', member_count: 2, ok: true, warning: undefined },
    ]);
    expect(listCachedMembers(db, 'zca-1')).toEqual([
      { user_id: 'u1', display_name: 'An' },
      { user_id: 'u2', display_name: 'Binh' },
    ]);
    runtime.maybeStopListening();
    db.close();
  });
});
