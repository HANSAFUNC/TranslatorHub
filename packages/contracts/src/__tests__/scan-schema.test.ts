import { describe, expect, it } from 'vitest';

import { scanBatchSchema, scanEntrySchema } from '../schemas';

/**
 * The scan payload's platform, which is part of a key's identity.
 *
 * `scanEntrySchema` had no such field at all, so zod stripped whatever a caller sent and the server
 * stored every key as `web` — a project whose files declared `ios` held 2,791 `web` keys and not one
 * `ios` key, while every document about the platform said the platform decides which key you are
 * talking about. The resolution the server now applies is `entry.platform ?? files[fileId].platform
 * ?? 'web'`, and this file pins the wire half of it.
 */
const ENTRY = {
  key: 'checkout.pay_now',
  namespace: '',
  locale: 'zh-CN',
  value: '立即支付',
  isSource: true,
  contentHash: 'a'.repeat(64),
  fileId: 'ios-zh-CN',
  filePath: 'InsureTalk/Resources/zh-Hans.lproj/Localizable.strings',
};

describe('a scan entry’s platform', () => {
  it('is optional, because the file it names normally carries it', () => {
    const parsed = scanEntrySchema.parse(ENTRY);
    expect(parsed.platform).toBeUndefined();
    expect(parsed.key).toBe('checkout.pay_now');
  });

  it('is accepted and kept when a caller states it', () => {
    expect(scanEntrySchema.parse({ ...ENTRY, platform: 'ios' }).platform).toBe('ios');
  });

  it('is validated against the platforms the platform knows', () => {
    // Not a free-form string: a typo here would create a key nobody can ever match again.
    expect(() => scanEntrySchema.parse({ ...ENTRY, platform: 'i0s' })).toThrow();
  });

  it('rides along in a batch, beside the file that also declares it', () => {
    const batch = scanBatchSchema.parse({
      projectId: '11111111-1111-1111-1111-111111111111',
      scanId: 'scan-1',
      files: [
        {
          fileId: 'ios-zh-CN',
          filePath: ENTRY.filePath,
          locale: 'zh-CN',
          platform: 'ios',
          format: 'ios-strings',
          fileHash: 'hash',
          entryCount: 1,
        },
      ],
      entries: [{ ...ENTRY, platform: 'ios' }],
    });
    expect(batch.files[0]!.platform).toBe('ios');
    expect(batch.entries[0]!.platform).toBe('ios');
  });
});
