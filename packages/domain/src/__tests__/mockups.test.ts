import { describe, expect, it } from 'vitest';
import { LocaleHubError, MAX_MOCKUP_BYTES, MAX_MOCKUP_DIMENSION } from '@localehub/contracts';

import { assertMockupDimensions, decodeMockupImage, resolveMockupInput } from '../mockups';

/**
 * Fixtures built from the formats' own specifications rather than checked in.
 *
 * A checked-in PNG is a file that quietly stops being a PNG — re-encoded by an editor, truncated by a
 * bad merge — and a test that reads its own fixture would keep passing. These live in the test that
 * uses them, so the domain package does not reach into another package's source tree.
 */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([signature, ihdr]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/**
 * The image gate.
 *
 * Everything here is about the moment untrusted bytes become something the platform will later serve
 * to a browser under a `content-type` this code chooses. The cases are the ones a caller could
 * actually send: a text file wearing an image mime type, an SVG that runs script, a small file that
 * would decode into a canvas no browser can paint.
 */

const base64 = (bytes: Buffer) => bytes.toString('base64');

describe('decodeMockupImage', () => {
  it('accepts a PNG and reads its size from the file rather than from the caller', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(png(1200, 800)), width: 1, height: 1 });
    expect(decoded.mimeType).toBe('image/png');
    expect(decoded.width).toBe(1200);
    expect(decoded.height).toBe(800);
    expect(() => assertMockupDimensions(decoded)).not.toThrow();
  });

  it('accepts a data: URL, which is what a browser tool hands over', () => {
    const decoded = decodeMockupImage({ imageBase64: `data:image/png;base64,${base64(png(4, 4))}` });
    expect(decoded.mimeType).toBe('image/png');
  });

  it('accepts a data: URL that carries parameters, which several exporters emit', () => {
    // `data:image/svg+xml;charset=utf-8;base64,…` used to be reported as "not valid base64": the strip
    // pattern demanded `;base64,` immediately after the media type, so the charset parameter stayed in
    // the payload and the caller was told its *encoding* was wrong.
    const svg = Buffer.from('<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
    const decoded = decodeMockupImage({ imageBase64: `data:image/svg+xml;charset=utf-8;base64,${base64(svg)}` });
    expect(decoded.mimeType).toBe('image/svg+xml');
    expect(decoded.width).toBe(8);
  });

  it('keeps the declared mime type for the response but never trusts it for the row', () => {
    // The dangerous direction: text announced as an image. Detection has to win, or the platform
    // stores a text file and later serves it back as `image/png`.
    expect(() => decodeMockupImage({ imageBase64: base64(Buffer.from('not an image')), mimeType: 'image/png' })).toThrow(
      /Unrecognised image/,
    );
  });

  it('refuses WebP by name, because it cannot read its dimensions', () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
    expect(() => decodeMockupImage({ imageBase64: base64(webp) })).toThrow(/WebP is not accepted/);
  });

  it('refuses an SVG that could act as a script, and names the construct to remove', () => {
    const svg = Buffer.from('<svg onload="alert(1)"><rect/></svg>');
    try {
      decodeMockupImage({ imageBase64: base64(svg) });
      expect.unreachable('an SVG with an event handler must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(LocaleHubError);
      expect((error as LocaleHubError).message).toContain('事件属性');
      expect((error as LocaleHubError).details).toMatchObject({ reasons: ['事件属性（onclick 等）'] });
    }
  });

  it('accepts an SVG that only draws', () => {
    const svg = Buffer.from('<svg viewBox="0 0 375 667"><rect x="10" y="10" width="80" height="30"/><text x="12" y="28">Pay</text></svg>');
    const decoded = decodeMockupImage({ imageBase64: base64(svg) });
    expect(decoded.mimeType).toBe('image/svg+xml');
    expect(decoded.width).toBe(375);
    expect(decoded.height).toBe(667);
  });

  it('refuses a canvas too large to paint, by name', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(png(MAX_MOCKUP_DIMENSION + 1, 10)) });
    try {
      assertMockupDimensions(decoded);
      expect.unreachable('an oversized canvas must be refused');
    } catch (error) {
      expect((error as LocaleHubError).message).toContain('limit is');
      // The advice matters: markers are fractions, so a smaller export does not need remarking.
      expect((error as LocaleHubError).message).toContain('markers are fractions');
    }
  });

  it('refuses an oversized payload before decoding it', () => {
    const huge = 'A'.repeat(Math.ceil((MAX_MOCKUP_BYTES * 4) / 3) + 1024);
    expect(() => decodeMockupImage({ imageBase64: huge })).toThrow(/the limit is/);
  });

  it('refuses bytes that are not base64', () => {
    expect(() => decodeMockupImage({ imageBase64: 'not base64!!' })).toThrow(/not valid base64/);
  });

  it('refuses an empty upload', () => {
    expect(() => decodeMockupImage({ imageBase64: '   ' })).toThrow(/empty/);
  });

  it('keeps the JPEG path working end to end', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(jpeg(375, 812)) });
    expect(decoded.mimeType).toBe('image/jpeg');
    expect(decoded.width).toBe(375);
    expect(decoded.height).toBe(812);
  });

  it('tolerates line breaks, which some clients insert every 76 characters', () => {
    const wrapped = base64(png(6, 6)).replace(/(.{4})/g, '$1\n');
    expect(decodeMockupImage({ imageBase64: wrapped }).mimeType).toBe('image/png');
  });
});
/**
 * The other input shape: a description instead of a picture.
 *
 * `resolveMockupInput` is the single place both surfaces (the MCP tool and `POST /mockups`) go
 * through, so it is where "the platform draws it" has to behave identically for both — including
 * the one thing a caller cannot see: which platform decides the canvas.
 */
/**
 * The drawn path, with the picture asserted present.
 *
 * `resolveMockupInput` now returns either a picture the platform drew or a page it is holding, and a
 * test about drawing has to say which one it expects — otherwise a change that silently routed a
 * description to the replica path would leave these passing on a null picture.
 */
function drawn(input: Parameters<typeof resolveMockupInput>[0]) {
  const resolved = resolveMockupInput(input);
  if (!resolved.image) throw new Error('expected the platform to draw a picture');
  return { ...resolved, image: resolved.image };
}

describe('resolveMockupInput', () => {
  const page = { root: { type: 'screen' as const, children: [{ type: 'text' as const, text: '下一步' }] } };

  it('draws a screen from a description and computes its markers', () => {
    const { image, markers } = drawn({ ui: page });
    expect(image.mimeType).toBe('image/svg+xml');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.key).toBe('下一步');
  });

  it('takes the canvas size from the call’s platform when the description omits one', () => {
    // The sketch guide tells a caller to send only `root`, because the screen's identity — name,
    // platform, locale — comes from the call. Before this, that advice produced an iOS screen laid
    // out on a 1280×800 web canvas.
    const { image } = drawn({ ui: page, platform: 'ios' });
    expect(image.width).toBe(390);
    expect(image.height).toBe(844);

    const web = drawn({ ui: page, platform: 'web' });
    expect(web.image.width).toBe(1280);
  });

  it('lets the description’s own platform win, since saying it twice means meaning it', () => {
    const { image } = drawn({ ui: { ...page, platform: 'android' }, platform: 'ios' });
    expect(image.width).toBe(412);
  });

  it('refuses both inputs, and neither, with a sentence that names the alternatives', () => {
    // The refusal names what was sent *and* what the alternatives are: "不要同时传" left a caller with
    // no idea which of the five inputs it should have picked.
    expect(() => drawn({ ui: page, imageBase64: base64(png(4, 4)) })).toThrow(/ui \+ image_base64.*五种输入选一种/s);
    expect(() => drawn({ html: '<div><p>你好</p></div>', ui: page })).toThrow(/只用一种输入/);
    // `document` + `ui` used to resolve to the page and drop the description silently: the caller got a
    // sketch that was neither of the two things it sent, and no message about it.
    expect(() =>
      resolveMockupInput({
        document: '<!doctype html><html><body><p data-key="a">hi</p></body></html>',
        ui: page,
        platform: 'ios',
      }),
    ).toThrow(/document \+ ui/);
    expect(() => drawn({})).toThrow(/传 ui/);
  });
});

/**
 * The page's own source as a third input.
 *
 * This is what makes a sketch worth uploading from an agent that has the markup: the page says which
 * elements it has, what they say, and — through its classes and styles — what they look like. The
 * server parses it with the same scanner the CLI runs on a checkout, and nothing in it is rendered or
 * executed.
 */
/**
 * A replica is drawn inside a frame the platform fixes, and the page has to have been drawn for it.
 *
 * The rule existed in the guide (S1/S3) and nowhere in the code, so it was not enforced and not even
 * reported: 19 of 29 Android pages in the field had coordinates outside the frame (0 of 32 iOS ones),
 * one of them declaring a 412×4250 canvas, and a login screen whose content ran to 1371px rendered as an
 * empty grey page while its report said `clean: true`. Refusing here is the whole point of the number:
 * the frame cannot be widened by the caller, so a page drawn for another canvas has no correct reading.
 */
describe('the frame a replica is drawn in', () => {
  const box = (left: number, top: number, width: number, height: number) =>
    `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:#eee"></div>`;
  const page = (body: string) => `<html><body><div data-key="home.title">我的</span>${body}</body></html>`;

  it('takes the canvas from the platform, not from the caller', () => {
    // `width`/`height` are not a way to widen the frame: a replica is shown at the size the screen is.
    const resolved = resolveMockupInput({
      document: page(box(0, 0, 412, 915)),
      platform: 'android',
      width: 1080,
      height: 2000,
    });
    expect(resolved.width).toBe(412);
    expect(resolved.height).toBe(915);
  });

  it('refuses a page whose coordinates run past it, and says which numbers', () => {
    // The field failure: 412dp read as px, so the page is laid out at twice the width.
    expect(() =>
      resolveMockupInput({ document: page(box(0, 0, 412, 915) + box(428, 100, 412, 44)), platform: 'android' }),
    ).toThrow(/412×915.*越界/s);

    const error = (() => {
      try {
        resolveMockupInput({ document: page(box(428, 100, 412, 44)), platform: 'android' });
      } catch (thrown) {
        return thrown as LocaleHubError;
      }
      return null;
    })();
    expect(error?.message).toContain('dp');
    expect(error?.details).toMatchObject({ frame: { width: 412, height: 915 }, ratio: 2.04 });
  });

  it('refuses a page that declares a canvas of its own', () => {
    const declaring = `<html><head><style>.screen{position:relative;width:412px;height:1371px;background:#fff}</style></head><body><div class="screen" data-key="home.title">我的</div></body></html>`;
    expect(() => resolveMockupInput({ document: declaring, platform: 'android' })).toThrow(/412×1371/);
  });

  it('accepts a page drawn for the frame, and one it cannot measure', () => {
    // A page of coordinates that fit, and a page arranged by flow (nothing to measure, nothing to say).
    expect(resolveMockupInput({ document: page(box(0, 0, 412, 915) + box(16, 100, 380, 44)), platform: 'android' }).width).toBe(412);
    expect(resolveMockupInput({ document: page('<div style="display:flex">我的</div>'), platform: 'android' }).width).toBe(412);
  });

  it('measures against the iOS frame for an iOS page', () => {
    // 390 wide, not 412: the same numbers that fit an Android page overflow an iPhone one.
    expect(() => resolveMockupInput({ document: page(box(0, 0, 400, 844)), platform: 'ios' })).toThrow(/390×844/);
    expect(resolveMockupInput({ document: page(box(0, 0, 390, 844)), platform: 'ios' }).width).toBe(390);
  });
});

describe('resolveMockupInput from html', () => {
  const page = `
    <style>.card { background: #f8fafc; border-radius: 12px; padding: 16px }</style>
    <body><div class="card">
      <h1 class="text-xl font-bold">课程详情</h1>
      <button class="bg-blue-600 text-white rounded-lg px-4 py-2">开始练习</button>
      <script>track('不是文案')</script>
    </div></body>`;

  it('draws the page and gets its strings, without executing anything it contains', () => {
    const { image, markers } = drawn({ html: page, platform: 'ios' });
    expect(image.mimeType).toBe('image/svg+xml');
    // One marker per visible string; the script body is not copy and is not in the picture.
    expect(markers.map((marker) => marker.key)).toEqual(['课程详情', '开始练习']);
    const svg = image.bytes.toString('utf8');
    expect(svg).toContain('课程详情');
    expect(svg).not.toContain('不是文案');
    expect(svg).not.toContain('<script');
  });

  it('carries the page’s colours into the picture', () => {
    const { image } = drawn({ html: page });
    const svg = image.bytes.toString('utf8');
    expect(svg).toContain('#2563eb'); // the button, from `bg-blue-600`
    expect(svg).toContain('#f8fafc'); // the card, from its own rule
  });

  it('stamps a namespace on every marker, the way the CLI’s --namespace does', () => {
    const { markers } = drawn({ html: page, namespace: 'Localizable' });
    expect(markers.every((marker) => marker.namespace === 'Localizable')).toBe(true);
  });

  it('refuses a source with nothing to draw, in the caller’s terms', () => {
    expect(() => drawn({ html: 'export const x = 1;' })).toThrow(/没有找到任何界面元素/);
  });
});
