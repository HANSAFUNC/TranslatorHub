import { describe, expect, it } from 'vitest';
import { contentHash, type AdapterInput, type FormatAdapter, type NormalizedEntry } from '@localehub/contracts';
import { JsonAdapter } from '../json-adapter';
import { YamlAdapter } from '../adapters/yaml';
import { AppleStringsAdapter } from '../adapters/ios-strings';
import { AndroidXmlAdapter, localeFromAndroidPath } from '../adapters/android-xml';
import { XcstringsAdapter } from '../adapters/xcstrings';
import { ArbAdapter, arbTagForLocale, localeFromArbPath, localeFromArbTag } from '../adapters/arb';
import { StringsdictAdapter } from '../adapters/stringsdict';
import { PoAdapter } from '../adapters/po';
import { XliffAdapter } from '../adapters/xliff';
import { createAdapter, formatForExtension } from '../index';
import { buildIcuPlural, parseIcuPlural } from '../icu';

function input(filePath: string, content: string, overrides: Partial<AdapterInput> = {}): AdapterInput {
  return {
    filePath,
    content: Buffer.from(content, 'utf8'),
    locale: 'ja-JP',
    namespace: 'common',
    platform: 'web',
    ...overrides,
  };
}

function asNormalized(adapterId: string, filePath: string, entries: Awaited<ReturnType<FormatAdapter['parse']>>): NormalizedEntry[] {
  return entries.map((entry) => ({
    projectId: 'prj_1',
    platform: entry.platform,
    namespace: entry.namespace,
    key: entry.key,
    locale: entry.locale,
    value: entry.value,
    isSource: false,
    description: entry.description,
    context: entry.context,
    placeholders: entry.placeholders,
    platformMetadata: entry.platformMetadata,
    fileId: adapterId,
    filePath,
    contentHash: contentHash(entry.value),
  }));
}

describe('JSON adapter', () => {
  const adapter = new JsonAdapter();

  it('parses nested keys into dot paths', async () => {
    const entries = await adapter.parse(
      input('apps/web/src/locales/ja-JP/common.json', JSON.stringify({ checkout: { pay_now: '今すぐ支払う' } }, null, 2)),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('checkout.pay_now');
    expect(entries[0].value).toBe('今すぐ支払う');
    expect(entries[0].placeholders).toEqual([]);
  });

  it('parses flat keys when keyMode is flat', async () => {
    const entries = await adapter.parse(
      input('flat.json', JSON.stringify({ 'checkout.pay_now': 'Pay now' }), { keyMode: 'flat' }),
    );
    expect(entries[0].key).toBe('checkout.pay_now');
  });

  it('extracts placeholders', async () => {
    const entries = await adapter.parse(input('p.json', JSON.stringify({ greeting: 'Hello {name}, you have %d items' })));
    expect(entries[0].placeholders?.map((p) => p.name).sort()).toEqual(['%d', 'name']);
  });

  it('patches a value in place and keeps formatting byte for byte', async () => {
    const original = ['{', '    "checkout": {', '        "pay_now": "Pay now",', '        "cart": "Cart"', '    },', '    "other": 42', '}', ''].join('\n');
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'checkout.pay_now',
          namespace: '',
          platform: 'web',
          locale: 'ja-JP',
          previousValue: 'Pay now',
          newValue: '今すぐ支払う',
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('"pay_now": "今すぐ支払う"');
    expect(text).toContain('        "cart": "Cart"'); // 8-space indentation preserved
    expect(text).toContain('    "other": 42'); // unrelated numeric untouched
    expect(JSON.parse(text).checkout.pay_now).toBe('今すぐ支払う');
  });

  it('inserts a brand new key using the file indentation', async () => {
    const original = `{\n  "a": "A"\n}\n`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'b.c', namespace: '', platform: 'web', locale: 'en-US', previousValue: null, newValue: 'C' }],
      preserveUnknownFields: true,
    });
    const parsed = JSON.parse(patched.toString('utf8'));
    expect(parsed).toEqual({ a: 'A', b: { c: 'C' } });
    expect(patched.toString('utf8')).toBe(`{\n  "a": "A",\n  "b": {\n    "c": "C"\n  }\n}\n`);
  });

  it('escapes quotes and newlines safely', async () => {
    const original = `{"k": "old"}`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'k', namespace: '', platform: 'web', locale: 'en-US', previousValue: 'old', newValue: 'a "quoted"\nline' }],
      preserveUnknownFields: true,
    });
    expect(JSON.parse(patched.toString('utf8')).k).toBe('a "quoted"\nline');
  });

  it('round-trips: parse -> serialize -> parse', async () => {
    const original = `{\n  "checkout": {\n    "pay_now": "Pay now"\n  }\n}\n`;
    const entries = await adapter.parse(input('en-US/common.json', original));
    const normalized = asNormalized('web-en', 'apps/web/src/locales/en-US/common.json', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('en-US/common.json', file.content));
    expect(reparsed.map((e) => [e.key, e.value])).toEqual(entries.map((e) => [e.key, e.value]));
  });

  it('reports a parse error with file and line information', async () => {
    await expect(adapter.parse(input('broken.json', '{\n  "a": \n}'))).rejects.toThrow(/Failed to parse JSON/);
  });
});

describe('YAML adapter', () => {
  const adapter = new YamlAdapter();

  it('parses and patches while preserving comments', async () => {
    const original = `# top comment\ncheckout:\n  # about pay now\n  pay_now: Pay now\n  cart: Cart\n`;
    const entries = await adapter.parse(input('ja.yaml', original));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'checkout.cart']);
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        { key: 'checkout.pay_now', namespace: '', platform: 'web', locale: 'ja', previousValue: 'Pay now', newValue: '今すぐ支払う' },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('今すぐ支払う');
    expect(text).toContain('# top comment');
    expect(text).toContain('cart: Cart');
  });
});

describe('Apple .strings adapter', () => {
  const adapter = new AppleStringsAdapter();

  it('parses keys, values, comments and escapes', async () => {
    const original = [
      '/* Checkout button */',
      '"checkout.pay_now" = "Pay now";',
      '"greeting" = "Hello \\"world\\"";',
      '"multi" = "line1\\nline2";',
    ].join('\n');
    const entries = await adapter.parse(input('ja.lproj/Localizable.strings', original));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ key: 'checkout.pay_now', value: 'Pay now', description: 'Checkout button' });
    expect(entries[1].value).toBe('Hello "world"');
    expect(entries[2].value).toBe('line1\nline2');
  });

  it('patches a value in place and preserves other lines and comments', async () => {
    const original = `/* keep me */\n"a" = "A";\n"b" = "B";\n`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [{ key: 'a', namespace: '', platform: 'ios', locale: 'ja', previousValue: 'A', newValue: 'あ' }],
      preserveUnknownFields: true,
    });
    expect(patched.toString('utf8')).toBe(`/* keep me */\n"a" = "あ";\n"b" = "B";\n`);
  });

  it('appends new keys when they are missing', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from('"a" = "A";\n', 'utf8'),
      changes: [{ key: 'b', namespace: '', platform: 'ios', locale: 'ja', previousValue: null, newValue: 'B' }],
      preserveUnknownFields: true,
    });
    expect(patched.toString('utf8')).toBe('"a" = "A";\n"b" = "B";\n');
  });

  it('round-trips values containing quotes and newlines', async () => {
    const entries = await adapter.parse(input('ja.lproj/Localizable.strings', '"k" = "say \\"hi\\"\\nnow";\n'));
    const normalized = asNormalized('ios-ja', 'ios/ja.lproj/Localizable.strings', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('ja.lproj/Localizable.strings', file.content));
    expect(reparsed[0].value).toBe(entries[0].value);
  });
});

describe('Android XML adapter', () => {
  const adapter = new AndroidXmlAdapter();

  it('parses string resources with attributes and comments', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Pay button -->
    <string name="checkout_pay_now">Pay now</string>
    <string name="app_name" translatable="false">Demo</string>
</resources>
`;
    const entries = await adapter.parse(input('android/app/src/main/res/values/strings.xml', original, { platform: 'android' }));
    expect(entries.map((e) => e.key)).toEqual(['checkout_pay_now', 'app_name']);
    expect(entries[0].description).toBe('Pay button');
    expect(entries[1].platformMetadata).toMatchObject({ translatable: false });
  });

  it('parses plurals into a canonical ICU value and patches a single branch', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <plurals name="cart_items">
        <item quantity="one">%d item</item>
        <item quantity="other">%d items</item>
    </plurals>
</resources>
`;
    const [entry] = await adapter.parse(input('android/app/src/main/res/values/plurals.xml', original, { platform: 'android' }));
    const plural = parseIcuPlural(entry.value);
    expect(plural?.quantities).toEqual({ one: '%d item', other: '%d items' });

    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'cart_items',
          namespace: '',
          platform: 'android',
          locale: 'ja',
          previousValue: entry.value,
          newValue: buildIcuPlural({ argName: 'count', quantities: { one: '%d 個', other: '%d 個' } }),
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<item quantity="one">%d 個</item>');
    expect(text).toContain('<item quantity="other">%d 個</item>');
    expect(text).not.toContain('%d items');
  });

  it('derives the locale from a values-* directory', () => {
    expect(localeFromAndroidPath('android/app/src/main/res/values-ja/strings.xml')).toBe('ja');
    expect(localeFromAndroidPath('android/app/src/main/res/values-zh-rCN/strings.xml')).toBe('zh-CN');
    expect(localeFromAndroidPath('android/app/src/main/res/values/strings.xml')).toBeNull();
  });

  it('round-trips strings including XML entities', async () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="amp">A &amp; B &lt;tag&gt;</string>\n</resources>\n`;
    const entries = await adapter.parse(input('res/values/strings.xml', original, { platform: 'android' }));
    expect(entries[0].value).toBe('A & B <tag>');
    const normalized = asNormalized('android-values', 'res/values/strings.xml', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('res/values/strings.xml', file.content, { platform: 'android' }));
    expect(reparsed[0].value).toBe('A & B <tag>');
  });
});

describe('.xcstrings adapter', () => {
  const adapter = new XcstringsAdapter();
  const catalog = {
    sourceLanguage: 'en',
    version: '1.0',
    strings: {
      'checkout.pay_now': {
        comment: 'Pay button',
        localizations: {
          en: { stringUnit: { state: 'translated', value: 'Pay now' } },
          ja: { stringUnit: { state: 'translated', value: '今すぐ支払う' } },
        },
      },
      'cart.items': {
        localizations: {
          ja: {
            variations: {
              plural: {
                one: { stringUnit: { state: 'translated', value: '%d 個' } },
                other: { stringUnit: { state: 'translated', value: '%d 個' } },
              },
            },
          },
        },
      },
    },
  };

  it('reads the requested locale only', async () => {
    const entries = await adapter.parse(input('ios/Resources/Localizable.xcstrings', JSON.stringify(catalog, null, 2), { locale: 'ja', platform: 'ios' }));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'cart.items']);
    expect(entries[0].value).toBe('今すぐ支払う');
    expect(parseIcuPlural(entries[1].value)?.quantities.other).toBe('%d 個');
  });

  it('patches a localization in place and preserves unrelated metadata', async () => {
    const source = JSON.stringify(catalog, null, 2);
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(source, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'ios', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const parsed = JSON.parse(patched.toString('utf8'));
    expect(parsed.strings['checkout.pay_now'].localizations.ja.stringUnit.value).toBe('今すぐお支払い');
    expect(parsed.strings['checkout.pay_now'].localizations.en.stringUnit.value).toBe('Pay now');
    expect(parsed.strings['checkout.pay_now'].comment).toBe('Pay button');
    expect(parsed.sourceLanguage).toBe('en');
  });
});

describe('.stringsdict adapter', () => {
  const adapter = new StringsdictAdapter();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>cart.items</key>
    <dict>
      <key>NSStringLocalizedFormatKey</key>
      <string>%#@count@</string>
      <key>count</key>
      <dict>
        <key>NSStringFormatSpecTypeKey</key>
        <string>NSStringPluralRuleType</string>
        <key>NSStringFormatValueTypeKey</key>
        <string>d</string>
        <key>one</key>
        <string>%d item</string>
        <key>other</key>
        <string>%d items</string>
      </dict>
    </dict>
  </dict>
</plist>
`;

  it('parses plural rules into canonical ICU', async () => {
    const [entry] = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', plist, { platform: 'ios' }));
    expect(entry.key).toBe('cart.items');
    const plural = parseIcuPlural(entry.value);
    expect(plural).toMatchObject({ argName: 'count', quantities: { one: '%d item', other: '%d items' } });
  });

  it('patches the quantity branches in place', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(plist, 'utf8'),
      changes: [
        {
          key: 'cart.items',
          namespace: '',
          platform: 'ios',
          locale: 'ja',
          previousValue: '',
          newValue: buildIcuPlural({ argName: 'count', quantities: { one: '%d 個', other: '%d 個' } }),
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<string>%d 個</string>');
    expect(text).not.toContain('%d items');
    expect(text).toContain('NSStringPluralRuleType');
  });

  it('round-trips the quantity set', async () => {
    const entries = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', plist, { platform: 'ios' }));
    const normalized = asNormalized('ios-plural', 'ios/ja.lproj/Localizable.stringsdict', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('ios/ja.lproj/Localizable.stringsdict', file.content, { platform: 'ios' }));
    expect(reparsed[0].value).toBe(entries[0].value);
  });
});

describe('PO adapter', () => {
  const adapter = new PoAdapter();
  const po = `# Translator comment
#. Checkout button label
#: src/checkout.tsx:42
msgid "checkout.pay_now"
msgstr "今すぐ支払う"

msgid "cart.items"
msgid_plural "cart.itemss"
msgstr[0] "%d item"
msgstr[1] "%d items"
`;

  it('parses msgid, comments and plural forms', async () => {
    const entries = await adapter.parse(input('locale/ja.po', po));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'checkout.pay_now', value: '今すぐ支払う', description: 'Checkout button label' });
    expect(parseIcuPlural(entries[1].value)?.quantities).toEqual({ zero: '%d item', one: '%d items' });
  });

  it('patches a msgstr in place, preserving comments', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(po, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'web', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('msgstr "今すぐお支払い"');
    expect(text).toContain('#: src/checkout.tsx:42');
  });

  it('round-trips a msgctxt key', async () => {
    const source = `msgctxt "menu"\nmsgid "Open"\nmsgstr "開く"\n`;
    const entries = await adapter.parse(input('locale/ja.po', source));
    expect(entries[0].key).toBe('menu\u0004Open');
    const normalized = asNormalized('po-ja', 'locale/ja.po', entries);
    const [file] = await adapter.serialize(normalized);
    const reparsed = await adapter.parse(input('locale/ja.po', file.content));
    expect(reparsed[0].key).toBe('menu\u0004Open');
    expect(reparsed[0].value).toBe('開く');
  });
});

describe('XLIFF adapter', () => {
  const adapter = new XliffAdapter();
  const xliff = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2">
  <file source-language="en" target-language="ja" datatype="plaintext" original="app">
    <body>
      <trans-unit id="checkout.pay_now">
        <source>Pay now</source>
        <target>今すぐ支払う</target>
        <note>Checkout button</note>
      </trans-unit>
      <trans-unit id="untouched">
        <source>Other</source>
        <target>その他</target>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

  it('parses units with notes', async () => {
    const entries = await adapter.parse(input('app.xliff', xliff));
    expect(entries.map((e) => e.key)).toEqual(['checkout.pay_now', 'untouched']);
    expect(entries[0].description).toBe('Checkout button');
  });

  it('patches only the requested unit', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(xliff, 'utf8'),
      changes: [{ key: 'checkout.pay_now', namespace: '', platform: 'universal', locale: 'ja', previousValue: '今すぐ支払う', newValue: '今すぐお支払い' }],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('<target>今すぐお支払い</target>');
    expect(text).toContain('<target>その他</target>');
    expect(text).toContain('<note>Checkout button</note>');
  });
});

describe('adapter registry', () => {
  it('maps file extensions to formats', () => {
    expect(formatForExtension('a/b.json')).toBe('json');
    expect(formatForExtension('a/b.xcstrings')).toBe('xcstrings');
    expect(formatForExtension('lib/l10n/app_zh_CN.arb')).toBe('arb');
    expect(formatForExtension('a/b.stringsdict')).toBe('ios-stringsdict');
    expect(formatForExtension('a/b.strings')).toBe('ios-strings');
    expect(formatForExtension('a/b.xliff')).toBe('xliff');
    expect(formatForExtension('a/b.po')).toBe('po');
    expect(formatForExtension('a/b.yaml')).toBe('yaml');
    expect(formatForExtension('a/b.xml')).toBe('android-xml');
    expect(formatForExtension('a/b.unknown')).toBeNull();
  });

  it('throws a typed error for an unknown format', () => {
    // `csv` used to stand in here as an unregistered format; it is registered now, so this uses
    // one that genuinely has no adapter.
    expect(() => createAdapter('parquet' as never)).toThrow(/No adapter registered/);
  });
});

/**
 * Flutter's ARB.
 *
 * The three things that make it not-just-JSON are each a way to break a real project: `@@locale`
 * (the file's own statement of which language it holds), `@key` metadata (what gen-l10n turns into
 * typed parameters, and what a template key must have or the build fails), and plural/select values
 * (objects in the file, one ICU message on the platform's side).
 */
describe('Flutter ARB adapter', () => {
  const adapter = new ArbAdapter();
  const EN = `{
  "@@locale": "en",
  "appTitle": "InsureTalk Flutter",
  "@appTitle": {
    "description": "App title (brand name, same in every language)"
  },
  "unknownRouteBody": "Unregistered route: {route}",
  "@unknownRouteBody": {
    "description": "Body of the unknown-route page",
    "placeholders": {
      "route": {
        "type": "String"
      }
    }
  }
}
`;

  it('reads entries, and takes the description and placeholders from the metadata', async () => {
    const entries = await adapter.parse(input('lib/l10n/app_en.arb', EN, { locale: 'en', platform: 'ios' }));
    expect(entries.map((entry) => entry.key)).toEqual(['appTitle', 'unknownRouteBody']);

    const [title, body] = entries;
    expect(title.value).toBe('InsureTalk Flutter');
    expect(title.description).toBe('App title (brand name, same in every language)');
    expect(body.description).toBe('Body of the unknown-route page');
    expect(body.placeholders).toEqual([{ name: 'route', type: 'String' }]);
    expect(body.platformMetadata?.arbLocale).toBe('en');
  });

  it('patches a value without touching the metadata, the order or the formatting', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(EN, 'utf8'),
      changes: [
        {
          key: 'unknownRouteBody',
          namespace: '',
          platform: 'ios',
          locale: 'zh-CN',
          previousValue: 'Unregistered route: {route}',
          newValue: '未注册的路由：{route}',
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('"unknownRouteBody": "未注册的路由：{route}"');
    // The metadata block, including the placeholder declaration, is untouched...
    expect(text).toContain('"placeholders": {');
    expect(text).toContain('"type": "String"');
    // ...and nothing else moved.
    expect(text.indexOf('"appTitle"')).toBeLessThan(text.indexOf('"unknownRouteBody"'));
    expect(text).toContain('"@@locale": "en"');
  });

  it('turns a plural object into one ICU message, taking the argument name from the metadata', async () => {
    const file = `{
  "@@locale": "en",
  "cartItems": {
    "one": "{count} item",
    "other": "{count} items"
  },
  "@cartItems": {
    "placeholders": {
      "count": {
        "type": "int"
      }
    }
  }
}
`;
    const [entry] = await adapter.parse(input('lib/l10n/app_en.arb', file, { locale: 'en' }));
    expect(entry.key).toBe('cartItems');
    const plural = parseIcuPlural(entry.value);
    expect(plural?.kind).toBe('plural');
    expect(plural?.argName).toBe('count');
    expect(plural?.quantities).toEqual({ one: '{count} item', other: '{count} items' });
  });

  it('reads a select as a select, not as a plural', async () => {
    // `{gender, plural, …}` is what a branch-name guess produces, and gen-l10n compiles it into
    // nonsense. The declared placeholder type is what settles it.
    const file = `{
  "@@locale": "en",
  "greeting": {
    "male": "Hello sir",
    "female": "Hello madam",
    "other": "Hello"
  },
  "@greeting": {
    "placeholders": {
      "gender": {
        "type": "String"
      }
    }
  }
}
`;
    const [entry] = await adapter.parse(input('lib/l10n/app_en.arb', file, { locale: 'en' }));
    const parsed = parseIcuPlural(entry.value);
    expect(parsed?.kind).toBe('select');
    expect(parsed?.argName).toBe('gender');
    expect(entry.value.startsWith('{gender, select,')).toBe(true);
  });

  it('writes a patched plural back as branches', async () => {
    const file = `{
  "@@locale": "en",
  "cartItems": {
    "one": "{count} item",
    "other": "{count} items"
  }
}
`;
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(file, 'utf8'),
      changes: [
        {
          key: 'cartItems',
          namespace: '',
          platform: 'ios',
          locale: 'zh-CN',
          previousValue: '{count, plural, one {{count} item} other {{count} items}}',
          newValue: buildIcuPlural({ argName: 'count', quantities: { one: '{count} 件', other: '{count} 件' } }),
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('"one": "{count} 件"');
    expect(text).toContain('"other": "{count} 件"');
    expect(text).not.toContain('"other": "{count} items"');
    // Still valid JSON with the key where it was.
    expect(Object.keys(JSON.parse(text))).toEqual(['@@locale', 'cartItems']);
  });

  it('refuses to flatten a plural into a plain string', async () => {
    const file = `{
  "@@locale": "en",
  "cartItems": {
    "one": "{count} item",
    "other": "{count} items"
  }
}
`;
    await expect(
      adapter.applyPatch({
        originalContent: Buffer.from(file, 'utf8'),
        changes: [
          {
            key: 'cartItems',
            namespace: '',
            platform: 'ios',
            locale: 'zh-CN',
            previousValue: '{count, plural, one {{count} item} other {{count} items}}',
            newValue: '{count} 件商品',
          },
        ],
        preserveUnknownFields: true,
      }),
    ).rejects.toThrow(/plural\/select branches/);
  });

  it('inserts a new key together with the placeholders its value uses', async () => {
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(EN, 'utf8'),
      changes: [
        {
          key: 'welcomeBack',
          namespace: '',
          platform: 'ios',
          locale: 'en',
          previousValue: null,
          newValue: 'Welcome back, {name}',
        },
      ],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    const root = JSON.parse(text) as Record<string, unknown>;
    expect(root.welcomeBack).toBe('Welcome back, {name}');
    // gen-l10n generates the parameter from this declaration — without it `{name}` is a literal.
    expect(root['@welcomeBack']).toEqual({ placeholders: { name: { type: 'String' } } });
  });

  it('warns when the file says it is a different language than the mapping does', async () => {
    const thai = EN.replace('"@@locale": "en"', '"@@locale": "zh"');
    const entries = await adapter.parse(input('lib/l10n/app_th.arb', thai, { locale: 'th-TH', platform: 'ios' }));
    const issues = await adapter.validate(asNormalized('arb', 'lib/l10n/app_th.arb', entries));
    expect(issues.map((issue) => issue.code)).toContain('ARB_LOCALE_MISMATCH');
  });

  it('warns when a value uses a placeholder the metadata does not declare', async () => {
    const file = `{
  "@@locale": "en",
  "greeting": "Hello {name}",
  "@greeting": {
    "description": "greeting"
  }
}
`;
    const entries = await adapter.parse(input('lib/l10n/app_en.arb', file, { locale: 'en' }));
    const issues = await adapter.validate(asNormalized('arb', 'lib/l10n/app_en.arb', entries));
    expect(issues.map((issue) => issue.code)).toContain('ARB_UNDECLARED_PLACEHOLDER');
  });

  it('keeps an ICU plural that the file wrote as a string as a string', async () => {
    // Both spellings are real ARB; the platform stores one canonical ICU message, and the file has
    // to come back the way it went in.
    const file = `{
  "@@locale": "en",
  "cartItems": "{count, plural, one {# item} other {# items}}",
  "@cartItems": {
    "placeholders": {
      "count": {
        "type": "int"
      }
    }
  }
}
`;
    const entries = await adapter.parse(input('lib/l10n/app_en.arb', file, { locale: 'en' }));
    const [serialized] = await adapter.serialize(asNormalized('arb', 'lib/l10n/app_en.arb', entries));
    const root = JSON.parse(serialized.content) as Record<string, unknown>;
    expect(typeof root.cartItems).toBe('string');
    expect(root.cartItems).toBe('{count, plural, one {# item} other {# items}}');
  });

  it('round-trips a file: parse -> serialize -> parse', async () => {
    const entries = await adapter.parse(input('lib/l10n/app_zh_CN.arb', EN, { locale: 'zh-CN', platform: 'ios' }));
    const [file] = await adapter.serialize(asNormalized('arb', 'lib/l10n/app_zh_CN.arb', entries));
    expect(JSON.parse(file.content)['@@locale']).toBe('zh_CN');
    const reparsed = await adapter.parse(input('lib/l10n/app_zh_CN.arb', file.content, { locale: 'zh-CN', platform: 'ios' }));
    expect(reparsed.map((entry) => [entry.key, entry.value, entry.description])).toEqual(
      entries.map((entry) => [entry.key, entry.value, entry.description]),
    );
    expect(reparsed[1]?.placeholders).toEqual([{ name: 'route', type: 'String' }]);
  });

  it('names the locale the way the file system does, in both directions', () => {
    expect(localeFromArbPath('lib/l10n/app_zh_CN.arb')).toBe('zh-CN');
    expect(localeFromArbPath('lib/l10n/app_zh_TW.arb')).toBe('zh-TW');
    expect(localeFromArbPath('lib/l10n/app_en.arb')).toBe('en');
    expect(localeFromArbPath('lib/l10n/l10n_pt_BR.arb')).toBe('pt-BR');
    // No locale in the name is not a locale.
    expect(localeFromArbPath('lib/l10n/app.arb')).toBeNull();
    expect(localeFromArbPath('lib/l10n/app_en.json')).toBeNull();

    expect(arbTagForLocale('zh-CN')).toBe('zh_CN');
    expect(arbTagForLocale('en')).toBe('en');
    expect(localeFromArbTag('zh_CN')).toBe('zh-CN');
    expect(localeFromArbTag('zh')).toBe('zh');
  });

  it('detects an ARB file by extension and content', async () => {
    expect(await adapter.detect('lib/l10n/app_en.arb', Buffer.from(EN, 'utf8'))).toBe(true);
    expect(await adapter.detect('lib/l10n/app_en.arb', Buffer.from('not json', 'utf8'))).toBe(false);
    expect(await adapter.detect('locales/en.json', Buffer.from(EN, 'utf8'))).toBe(false);
  });
});
