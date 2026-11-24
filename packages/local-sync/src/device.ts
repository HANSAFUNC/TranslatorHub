import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ErrorCode, LocaleHubError, imageDimensions } from '@localehub/contracts';

/**
 * Talking to a device, without pretending it is a filesystem.
 *
 * A native app that exists only as an installed APK cannot be read as source, but it can be *run*, and
 * a running screen is the most reliable description of itself there is: `screencap` for the pixels,
 * `uiautomator dump` for where every element sits. Both come from the same moment, so the picture and
 * the boxes cannot disagree.
 *
 * The runner is injected rather than imported so this can be tested without a device attached — the
 * whole of it is "which commands, in what order, and what does the output mean", which is exactly what
 * a fake runner can check.
 */

export interface DeviceRunResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

/** One `adb` invocation. Throws when the binary itself is missing. */
export type DeviceRun = (file: string, args: string[]) => DeviceRunResult;

/**
 * Where `adb` might be, in the order worth trying.
 *
 * It is very often not on `PATH` — every SDK install puts it in `platform-tools/` and only some of them
 * add it to the shell profile. On the machine this was written against, `which adb` printed nothing
 * while `~/Library/Android/sdk/platform-tools/adb` worked, so a driver that trusted `PATH` alone would
 * have reported "no adb" on a machine with a phone plugged into it.
 */
export function adbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? '';
  return [
    'adb',
    ...(env.ANDROID_HOME ? [join(env.ANDROID_HOME, 'platform-tools', 'adb')] : []),
    ...(env.ANDROID_SDK_ROOT ? [join(env.ANDROID_SDK_ROOT, 'platform-tools', 'adb')] : []),
    ...(home ? [join(home, 'Library/Android/sdk/platform-tools/adb'), join(home, 'Android/Sdk/platform-tools/adb')] : []),
  ];
}

/** The first candidate that actually runs. */
export function pickAdbBinary(candidates: readonly string[] = adbCandidates()): string {
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new LocaleHubError(
    ErrorCode.VALIDATION_ERROR,
    '找不到 adb。装 Android Platform Tools（或 `brew install android-platform-tools`），' +
      `或者把它的路径放进 PATH；找过这些位置：${candidates.join('、')}`,
    422,
  );
}

/**
 * The real thing: `spawnSync`, binary stdout, and a resolved `adb`.
 *
 * stdout stays a `Buffer` on purpose. A screenshot through a string-encoded pipe is already damaged
 * before any code here sees it, and the damage (every `\n` becoming `\r\n`) still looks like a PNG.
 */
export function systemDeviceRunner(env: NodeJS.ProcessEnv = process.env): DeviceRun {
  let binary: string | null = null;
  return (file, args) => {
    if (file !== 'adb') throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `只支持 adb，收到 ${file}`, 500);
    binary ??= pickAdbBinary(adbCandidates(env));
    const result = spawnSync(binary, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `执行 ${binary} 失败：${result.error.message}`, 502);
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
    };
  };
}

export interface AndroidDevice {
  serial: string;
  model: string;
  state: string;
}

export interface CapturedScreen {
  image: Buffer;
  /** The dump document, as the device wrote it. */
  dumpXml: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  device: {
    serial: string;
    model: string;
    release: string;
    locale: string;
    package: string | null;
    activity: string | null;
  };
}

const text = (result: DeviceRunResult): string => result.stdout.toString('utf8');

function adb(run: DeviceRun, args: string[], what: string): DeviceRunResult {
  const result = run('adb', args);
  if (result.status !== 0) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `adb ${args.join(' ')} 失败（${what}）：${result.stderr.trim() || `退出码 ${result.status}`}`,
      502,
    );
  }
  return result;
}

/** `adb devices -l`, which is the only way to know which device a bare `adb` would pick. */
export function listAndroidDevices(run: DeviceRun): AndroidDevice[] {
  const output = text(adb(run, ['devices', '-l'], '列出设备'));
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*'))
    .map((line) => {
      const [serial = '', state = ''] = line.split(/\s+/);
      const model = /\bmodel:(\S+)/.exec(line)?.[1] ?? '';
      return { serial, model: model.replace(/_/g, ' '), state };
    })
    .filter((device) => device.serial.length > 0);
}

/**
 * Which device to capture.
 *
 * One attached device is unambiguous; more than one is a question only the caller can answer, and
 * picking for them would photograph the wrong phone and say nothing about it.
 */
export function resolveDevice(run: DeviceRun, serial?: string): AndroidDevice {
  const devices = listAndroidDevices(run).filter((device) => device.state === 'device');
  if (serial) {
    const found = devices.find((device) => device.serial === serial);
    if (!found) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `没有连着的设备叫 ${serial}。当前：${devices.map((d) => d.serial).join(', ') || '（一个都没有）'}`,
        422,
        { devices },
      );
    }
    return found;
  }
  if (devices.length === 1) return devices[0]!;
  if (!devices.length) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '没有可用的安卓设备。接上手机（开 USB 调试）或启动模拟器，`adb devices` 里出现 device 再试。',
      422,
    );
  }
  throw new LocaleHubError(
    ErrorCode.VALIDATION_ERROR,
    `连着 ${devices.length} 台设备，用 --serial 指定一台：${devices.map((d) => `${d.serial}（${d.model || '未知型号'}）`).join('、')}`,
    422,
    { devices },
  );
}

function property(run: DeviceRun, serial: string, name: string): string {
  const result = run('adb', ['-s', serial, 'shell', 'getprop', name]);
  return result.status === 0 ? text(result).trim() : '';
}

/** The foreground package and activity, which is what the screen *is* — not what the device is. */
function resumedActivity(run: DeviceRun, serial: string): { package: string | null; activity: string | null } {
  const result = run('adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
  if (result.status !== 0) return { package: null, activity: null };
  const output = text(result);
  const match =
    /(?:topResumedActivity|mResumedActivity)[^}]*?\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/.exec(output) ??
    /ResumedActivity:\s*ActivityRecord\{[^}]*\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/.exec(output);
  return { package: match?.[1] ?? null, activity: match?.[2] ?? null };
}

/**
 * One screen, as it currently is.
 *
 * The dump is written to the device and read back rather than streamed: `uiautomator dump` insists on a
 * path, and reading it out with `cat` keeps the whole thing to plain `adb` calls — no `adb pull` into a
 * directory the workspace guard would then have to have an opinion about. The file is removed again so
 * a device is left as it was found.
 */
export function captureAndroidScreen(run: DeviceRun, options: { serial?: string } = {}): CapturedScreen {
  const device = resolveDevice(run, options.serial);
  const serial = device.serial;

  // `exec-out`, never `shell`: a shell on the way out rewrites \n to \r\n and the PNG is quietly
  // corrupt from the first chunk. Every capture tool that ever produced an unreadable screenshot did it
  // this way.
  const shot = adb(run, ['-s', serial, 'exec-out', 'screencap', '-p'], '截屏');
  const dimensions = imageDimensions(shot.stdout, 'image/png');
  if (!dimensions) throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, '设备返回的截图不是 PNG，截屏失败。', 502);

  const remote = `/sdcard/localehub-ui-${Date.now()}.xml`;
  const dump = adb(run, ['-s', serial, 'shell', 'uiautomator', 'dump', '--compressed', remote], '取界面层级');
  const read = run('adb', ['-s', serial, 'shell', 'cat', remote]);
  // `<hierarchy></hierarchy>` is a successful dump of nothing: a screen mid-animation, a fullscreen
  // video surface, or a moment during an activity switch. Requiring an actual `<node>` is what tells
  // "there was nothing to read" apart from "there was nothing to read *yet*".
  if (read.status !== 0 || !/<node\b/.test(text(read))) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `没有取到界面层级（uiautomator 说：${text(dump).trim() || '无输出'}）。屏幕正在动画、全屏视频或应用刚切换时会是空树，等界面稳定后重试。`,
      502,
    );
  }
  run('adb', ['-s', serial, 'shell', 'rm', '-f', remote]);

  const { package: packageName, activity } = resumedActivity(run, serial);
  return {
    image: shot.stdout,
    dumpXml: text(read),
    mimeType: 'image/png',
    width: dimensions.width,
    height: dimensions.height,
    device: {
      serial,
      model: property(run, serial, 'ro.product.model') || device.model,
      release: property(run, serial, 'ro.build.version.release'),
      locale: property(run, serial, 'persist.sys.locale') || property(run, serial, 'ro.product.locale'),
      // The dump's own package is the authority; this is only a cross-check for the manifest.
      package: packageName,
      activity,
    },
  };
}
