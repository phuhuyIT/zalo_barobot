import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { webRouter } from '../src/channels/web';
import * as storeModule from '../src/store';
import * as configModule from '../src/config';
import * as sheetsModule from '../src/sheets';

describe('Web API Endpoints (F12 & F13)', () => {
  let server: Server;
  let baseUrl: string;
  let mockDb: Database.Database;

  beforeEach(async () => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);

    process.env.GOOGLE_SHEET_ID = 'mock_spreadsheet_id';

    configModule.setConfig({
      squads: {
        main: {
          display_name: 'Tiểu đội 2',
          sheet_tab_gate_duty: 'Tab_Main',
          header_style: 'two_row_merged',
          overnight: false,
        },
      },
      recipients: {
        group_main: 'chat_group_main',
        admin: 'chat_admin',
      },
      schedules: [
        {
          key: 'main_duty',
          label: 'Lịch trực cổng Tiểu đội 2',
          squad: 'main',
          type: 'gate_duty',
          recipients: ['group_main'],
          auto_send_time: '05:30',
          enabled: true,
        },
        {
          key: 'leave_stats',
          label: 'Thống kê tranh thủ Tiểu đội 2',
          squad: 'main',
          type: 'leave_roster_stats',
          sheet_tab: 'Lịch tranh thủ tiểu đội 2',
          recipients: ['group_main'],
          auto_send_time: null,
          enabled: true,
        },
      ],
      reminders: [],
    });

    // Seed defaults into store
    storeModule.seedDefaultRecipients([
      { key: 'group_main', display_name: 'Nhóm Tiểu đội 2', chat_id: 'chat_group_main' },
      { key: 'admin', display_name: 'Quản trị viên', chat_id: 'chat_admin' },
    ], mockDb);

    const app = express();
    app.use(express.json());
    app.use(webRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    mockDb.close();
  });

  describe('F12: Recipient Management API', () => {
    it('GET /api/recipients returns recipients with assigned schedules', async () => {
      const res = await fetch(`${baseUrl}/api/recipients`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.recipients.length).toBe(2);

      const groupMain = data.recipients.find((r: any) => r.key === 'group_main');
      expect(groupMain).toBeDefined();
      expect(groupMain.assignedSchedules).toHaveLength(2);
      expect(groupMain.assignedSchedules[0].key).toBe('main_duty');
    });

    it('POST /api/recipients creates a new recipient and rejects invalid payload', async () => {
      // Missing fields
      const badRes = await fetch(`${baseUrl}/api/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'new_rec' }),
      });
      expect(badRes.status).toBe(400);

      // Valid creation
      const res = await fetch(`${baseUrl}/api/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'group_culi',
          display_name: 'Nhóm Culi Phụ',
          chat_id: 'chat_culi_999',
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.recipient.key).toBe('group_culi');

      const stored = storeModule.getRecipient('group_culi', mockDb);
      expect(stored).toBeDefined();
      expect(stored?.chat_id).toBe('chat_culi_999');
    });

    it('rejects a cross-origin POST and accepts the page host', async () => {
      const cross = await fetch(`${baseUrl}/api/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ key: 'evil', display_name: 'Evil', chat_id: 'x' }),
      });
      expect(cross.status).toBe(403);
      expect(storeModule.getRecipient('evil', mockDb)).toBeNull();

      const same = await fetch(`${baseUrl}/api/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: new URL(baseUrl).origin },
        body: JSON.stringify({ key: 'same_origin', display_name: 'Same', chat_id: 'chat_same' }),
      });
      expect(same.status).toBe(200);

      const listed = await fetch(`${baseUrl}/api/recipients`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(listed.status).toBe(200);
    });

    it('PUT /api/recipients/:key updates recipient details', async () => {
      const res = await fetch(`${baseUrl}/api/recipients/group_main`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: 'Nhóm Tiểu Đội 2 Mới',
          chat_id: 'chat_main_updated',
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const updated = storeModule.getRecipient('group_main', mockDb);
      expect(updated?.display_name).toBe('Nhóm Tiểu Đội 2 Mới');
      expect(updated?.chat_id).toBe('chat_main_updated');
    });

    it('DELETE /api/recipients/:key deletes recipient and removes from schedule assignments', async () => {
      // First, set runtime override assigning group_main and admin to main_duty
      storeModule.saveRuntimeConfigOverride('main_duty', {
        recipients: ['group_main', 'admin'],
      }, mockDb);

      const delRes = await fetch(`${baseUrl}/api/recipients/group_main`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.success).toBe(true);
      expect(delData.affectedSchedules).toContain('main_duty');

      // Verify recipient is gone from store
      expect(storeModule.getRecipient('group_main', mockDb)).toBeNull();

      // Verify runtime override no longer contains group_main
      const override = storeModule.getRuntimeConfigOverride('main_duty', mockDb);
      expect(override?.recipients).toEqual(['admin']);
    });
  });

  describe('F9 & F12: Schedule Config Overrides API', () => {
    it('POST /api/config saves multi-recipient assignment override', async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedules: [
            {
              key: 'main_duty',
              recipients: ['admin'],
              autoSendTime: '06:00',
              enabled: true,
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const override = storeModule.getRuntimeConfigOverride('main_duty', mockDb);
      expect(override?.recipients).toEqual(['admin']);
      expect(override?.auto_send_time).toBe('06:00');
    });
  });

  describe('F13: Leave Stats API', () => {
    it('GET /api/leave-stats returns computed metrics for leave roster', async () => {
      vi.spyOn(sheetsModule, 'fetchLeaveStats').mockResolvedValue({
        stats: [
          {
            name: 'Nguyễn Văn A',
            leaveCount: 2,
            missedCount: 0,
            lastLeaveDate: '01/09',
            turnsSinceLastLeave: 1,
          },
          {
            name: 'Trần Văn B',
            leaveCount: 0,
            missedCount: 1,
            lastLeaveDate: 'Chưa từng về',
            turnsSinceLastLeave: null,
          },
        ],
        totalTurns: 3,
        totalLeaves: 2,
        totalMissed: 1,
      });

      const res = await fetch(`${baseUrl}/api/leave-stats?tabName=Tab_Leave`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.totalTurns).toBe(3);
      expect(data.data.stats).toHaveLength(2);
      expect(data.data.stats[0].name).toBe('Nguyễn Văn A');
    });
  });

  describe('Patrol Platoon Leader API', () => {
    it('allows reading and updating platoon_leader chat ID via /api/patrol/platoon-leader', async () => {
      // 1. Initial read
      const getRes1 = await fetch(`${baseUrl}/api/patrol/platoon-leader`);
      expect(getRes1.status).toBe(200);
      const getData1 = await getRes1.json();
      expect(getData1.success).toBe(true);

      // 2. Update platoon leader chat ID
      const putRes = await fetch(`${baseUrl}/api/patrol/platoon-leader`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'leader_chat_999' }),
      });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();
      expect(putData.success).toBe(true);
      expect(putData.chatId).toBe('leader_chat_999');

      // 3. Verify via GET endpoint
      const getRes2 = await fetch(`${baseUrl}/api/patrol/platoon-leader`);
      const getData2 = await getRes2.json();
      expect(getData2.success).toBe(true);
      expect(getData2.chatId).toBe('leader_chat_999');

      // 4. Verify /api/patrol/sites returns updated platoonLeaderChatId
      const sitesRes = await fetch(`${baseUrl}/api/patrol/sites`);
      const sitesData = await sitesRes.json();
      expect(sitesData.success).toBe(true);
      expect(sitesData.platoonLeaderChatId).toBe('leader_chat_999');
    });
  });
});
