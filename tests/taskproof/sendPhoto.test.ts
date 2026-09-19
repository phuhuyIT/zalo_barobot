import { describe, expect, it } from 'vitest';
import { ZaloClient } from '../../src/core/zaloClient';

describe('ZaloClient.sendPhoto (Step 5)', () => {
  it('trims ZALO_BOT_TOKEN so a leading space does not break sendPhoto', () => {
    const previous = process.env.ZALO_BOT_TOKEN;
    process.env.ZALO_BOT_TOKEN = '  dummy-token-with-space  ';
    const client = new ZaloClient();
    expect((client as unknown as { token: string }).token).toBe('dummy-token-with-space');
    if (previous === undefined) delete process.env.ZALO_BOT_TOKEN;
    else process.env.ZALO_BOT_TOKEN = previous;
  });

  it('rejects a filesystem path — photo must be an https URL', async () => {
    const client = new ZaloClient('dummy-token');
    await expect(client.sendPhoto('chat_1', '/data/qr-tmp/abc.png')).rejects.toThrow(/https/);
    await expect(client.sendPhoto('chat_1', 'http://insecure.example/qr.png')).rejects.toThrow(/https/);
  });
});
