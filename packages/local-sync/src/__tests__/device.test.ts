import { describe, expect, it } from 'vitest';
import { captureAndroidScreen, listAndroidDevices, resolveDevice, type DeviceRun } from '../device';

/**
 * The commands, in order, and what their output means.
 *
 * Everything here is testable without a device because the driver is a pure function of "run this
 * command, get these bytes back" — which is also what makes it worth writing down: the three ways a
 * capture goes wrong (the wrong device, a corrupt screenshot, an empty hierarchy) are all decided here.
 */

const PNG = (() => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(1080, 8);
  ihdr.writeUInt32BE(1920, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([signature, ihdr]);
})();

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="登录" resource-id="com.example.app:id/tv_login" class="android.widget.TextView" package="com.example.app" bounds="[58,527][371,611]"/></hierarchy>`;

interface Call {
  file: string;
  args: string[];
}

/** A device that answers exactly what it is told to answer, and records what it was asked. */
function fakeDevice(answers: Record<string, { status?: number; stdout?: Buffer | string; stderr?: string }>): {
  run: DeviceRun;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: DeviceRun = (file, args) => {
    calls.push({ file, args });
    const key = [file, ...args].join(' ');
    for (const [pattern, answer] of Object.entries(answers)) {
      if (!key.includes(pattern)) continue;
      const stdout = answer.stdout ?? '';
      return {
        status: answer.status ?? 0,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'),
        stderr: answer.stderr ?? '',
      };
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  return { run, calls };
}

const ONE_DEVICE = {
  'devices -l': { stdout: 'List of devices attached\n127.0.0.1:5555       device product:p3sxxx model:SM_G998B device:p3s transport_id:4\n' },
  'exec-out screencap': { stdout: PNG },
  'uiautomator dump': { stdout: 'UI hierchary dumped to: /sdcard/localehub-ui.xml\n' },
  'shell cat': { stdout: DUMP },
  'getprop ro.product.model': { stdout: 'SM-G998B\n' },
  'getprop ro.build.version.release': { stdout: '13\n' },
  'getprop persist.sys.locale': { stdout: 'zh-CN\n' },
  'dumpsys activity activities': {
    stdout: '    topResumedActivity=ActivityRecord{c8293c6 u0 com.example.app/com.example.app.MainActivity} t82}\n',
  },
};

describe('listAndroidDevices', () => {
  it('reads the serial, the model and the state off `adb devices -l`', () => {
    const { run } = fakeDevice({
      ...ONE_DEVICE,
      'devices -l': {
        stdout:
          'List of devices attached\n' +
          '127.0.0.1:5555       device product:p3sxxx model:SM_G998B device:p3s transport_id:4\n' +
          '127.0.0.1:5565       offline product:p3sxxx model:P60_Pro device:p3s transport_id:3\n' +
          'emulator-5554        device product:sdk_gphone model:Pixel_6 device:generic transport_id:2\n',
      },
    });
    expect(listAndroidDevices(run)).toEqual([
      { serial: '127.0.0.1:5555', model: 'SM G998B', state: 'device' },
      { serial: '127.0.0.1:5565', model: 'P60 Pro', state: 'offline' },
      { serial: 'emulator-5554', model: 'Pixel 6', state: 'device' },
    ]);
  });
});

describe('resolveDevice', () => {
  it('takes the only attached device', () => {
    const { run } = fakeDevice(ONE_DEVICE);
    expect(resolveDevice(run).serial).toBe('127.0.0.1:5555');
  });

  it('refuses to choose between several, and names them', () => {
    // Photographing the wrong phone and saying nothing about it is the failure this prevents.
    const { run } = fakeDevice({
      'devices -l': {
        stdout:
          'List of devices attached\n127.0.0.1:5555 device model:SM_G998B\n127.0.0.1:5565 device model:P60_Pro\n',
      },
    });
    expect(() => resolveDevice(run)).toThrow(/--serial/);
    expect(() => resolveDevice(run)).toThrow(/127\.0\.0\.1:5555（SM G998B）、127\.0\.0\.1:5565（P60 Pro）/);
  });

  it('ignores a device that is not ready, rather than capturing a black screen from it', () => {
    const { run } = fakeDevice({
      'devices -l': { stdout: 'List of devices attached\n127.0.0.1:5555 unauthorized model:SM_G998B\n' },
    });
    expect(() => resolveDevice(run)).toThrow(/没有可用的安卓设备/);
  });

  it('says so when the serial asked for is not attached', () => {
    const { run } = fakeDevice(ONE_DEVICE);
    expect(() => resolveDevice(run, 'emulator-5554')).toThrow(/没有连着的设备叫 emulator-5554/);
  });
});

describe('captureAndroidScreen', () => {
  it('captures the pixels and the hierarchy, and cleans up after itself', () => {
    const { run, calls } = fakeDevice(ONE_DEVICE);
    const captured = captureAndroidScreen(run);

    expect(captured.width).toBe(1080);
    expect(captured.height).toBe(1920);
    expect(captured.dumpXml).toContain('tv_login');
    expect(captured.device).toMatchObject({
      serial: '127.0.0.1:5555',
      model: 'SM-G998B',
      release: '13',
      locale: 'zh-CN',
      package: 'com.example.app',
      activity: 'com.example.app.MainActivity',
    });
    // The screenshot is taken with `exec-out`, not `shell`: a shell on the way out rewrites \n to \r\n
    // and the PNG is quietly corrupt.
    const shot = calls.find((call) => call.args.includes('screencap'))!;
    expect(shot.args).toContain('exec-out');
    expect(shot.args).not.toContain('shell');
    // And the device is left as it was found.
    expect(calls.some((call) => call.args.join(' ').includes('rm -f /sdcard/'))).toBe(true);
  });

  it('calls the device-side dump by path, and reads it back with cat', () => {
    const { run, calls } = fakeDevice(ONE_DEVICE);
    captureAndroidScreen(run);
    const dump = calls.find((call) => call.args.includes('uiautomator'))!;
    expect(dump.args.join(' ')).toMatch(/dump --compressed \/sdcard\/localehub-ui-\d+\.xml/);
    expect(calls.some((call) => call.args.join(' ').includes('shell cat /sdcard/localehub-ui-'))).toBe(true);
  });

  it('refuses an empty hierarchy, because a screen mid-animation has nothing to mark', () => {
    const { run } = fakeDevice({ ...ONE_DEVICE, 'shell cat': { stdout: '<?xml version=…?><hierarchy rotation="0"></hierarchy>' } });
    expect(() => captureAndroidScreen(run)).toThrow(/没有取到界面层级/);
  });

  it('refuses bytes that are not a PNG, instead of uploading something unreadable', () => {
    const { run } = fakeDevice({ ...ONE_DEVICE, 'exec-out screencap': { stdout: Buffer.from('\r\n\u0000\u0000garbage') } });
    expect(() => captureAndroidScreen(run)).toThrow(/不是 PNG/);
  });

  it('reports what adb said when the command itself fails', () => {
    const { run } = fakeDevice({
      ...ONE_DEVICE,
      'devices -l': { status: 1, stderr: 'adb: no such file or directory' },
    });
    expect(() => captureAndroidScreen(run)).toThrow(/adb devices -l 失败/);
  });

  it('honours --serial by passing it to every command', () => {
    const { run, calls } = fakeDevice({
      ...ONE_DEVICE,
      'devices -l': {
        stdout: 'List of devices attached\n127.0.0.1:5555 device model:SM_G998B\n127.0.0.1:5565 device model:P60_Pro\n',
      },
    });
    const captured = captureAndroidScreen(run, { serial: '127.0.0.1:5565' });
    expect(captured.device.serial).toBe('127.0.0.1:5565');
    const perDevice = calls.filter((call) => call.args[0] === '-s');
    expect(perDevice.every((call) => call.args[1] === '127.0.0.1:5565')).toBe(true);
  });
});
