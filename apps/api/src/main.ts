import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ErrorCode, MAX_MOCKUP_BYTES, MAX_MOCKUP_REQUEST_BYTES, MAX_SCAN_REQUEST_BYTES } from '@localehub/contracts';
import { contextRequestId } from './common/request-context';
import { corsOrigins, loadEnv } from '@localehub/config';
import { AppModule } from './app.module';

/**
 * The request-body ceiling for a mockup upload.
 *
 * `MAX_MOCKUP_BYTES` is 2 MB of image, base64 expands it by ~4/3, and the rest of the request is the
 * marker list — 4 MB is the same figure the MCP transport enforces, so the two surfaces agree about
 * what "too big" means.
 */
/**
 * The body parser for one route, plus the refusal a caller gets when it sends more than that route
 * is documented to carry.
 *
 * Kept as a function because there is more than one such route now, and a second copy of the
 * envelope-and-requestId handling below is how the two would drift apart.
 */
interface LargeBodyRoute {
  path: string;
  limitBytes: number;
  tooLargeMessage: (megabytes: number) => string;
  tooLargeDetails?: Record<string, unknown>;
}

function mountLargeBodyParser(app: NestExpressApplication, route: LargeBodyRoute): void {
  const megabytes = Math.max(1, Math.round(route.limitBytes / 1024 / 1024));
  const parser = json({ limit: `${megabytes}mb` });

  /** Named anything but `jsonParser`: see where it is mounted. */
  const parse = (request: Request, response: Response, next: NextFunction): void => {
    parser(request, response, next);
  };

  app.use(
    route.path,
    parse,
    // A middleware mounted by hand runs outside Nest's exception filter, so a refusal here has to be
    // written in the same envelope every other failure uses — otherwise a 413 arrives as Express's
    // default HTML page and the client's error handling has nothing to render.
    (error: { status?: number; type?: string; message?: string }, request: Request, response: Response, next: NextFunction) => {
      if (!error) return next();
      const status = typeof error.status === 'number' && error.status >= 400 ? error.status : 400;
      // This middleware runs before Nest's request-context middleware, so there is no id in the async
      // context yet — but a client that correlates errors by `requestId` should not hit the one error
      // it cannot correlate. Take the caller's header when it sent one (the same rule the middleware
      // uses) and mint one otherwise; either way it is also set as the response header, so it lines up
      // with what the logs would show for the same request.
      const requestId = contextRequestId() ?? (request.headers['x-request-id'] as string | undefined) ?? randomUUID();
      response.setHeader('x-request-id', requestId);
      // "request entity too large" is body-parser's sentence, and it names neither the limit nor what
      // to do about it. The limit a caller can hit is documented, so the refusal says which one and
      // where the budget went — a caller can act on that and cannot act on "too large".
      const tooLarge = status === 413;
      response.status(status).json({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: tooLarge ? route.tooLargeMessage(megabytes) : (error.message ?? 'Invalid request body'),
          details: tooLarge ? route.tooLargeDetails : undefined,
          requestId,
        },
      });
    },
  );
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  // `trust proxy` decides whether X-Forwarded-For/Proto may be believed. It is off unless a
  // reverse proxy really is in front, because a client could otherwise spoof a fresh IP per
  // request and sidestep the rate limiter.
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableCors({
    // Shares its source with the CSRF guard (`corsOrigins`), so the two cannot disagree.
    origin: corsOrigins(),
    credentials: true,
  });
  // A larger body limit, on the routes that legitimately carry one.
  //
  // Two of them do. A screen mockup arrives as a base64 image (~4/3 its bytes), so the sketch route
  // needs the 4 MB ceiling the MCP transport documents. A repository scan carries every entry the
  // repository has, and the platform's own batch cap (`SYNC_MAX_ENTRIES_PER_BATCH`, 20,000 entries)
  // is far past Express's 100 kB default — with that default in place, a real project's scan was
  // refused with "request entity too large" and the CLI reported the scan as a success, because the
  // upload result went unprinted. Both routes get a limit sized to what they are documented to carry.
  //
  // The earlier fix for the mockup limit raised it for *every* route, which meant `/auth/login` and
  // the rest buffered and parsed up to 4 MB before AuthGuard or the rate limiter ran. This parser is
  // registered first (middleware added here runs before Nest's own), and body-parser skips a request
  // whose body is already parsed, so every other route keeps Express's 100 kB default.
  //
  // The wrapper is load-bearing, not decoration. Nest decides whether to register its own app-wide
  // JSON parser by looking for a middleware layer named `jsonParser` — which is exactly what
  // `json(…)` is — so mounting it directly here made Nest skip its parser entirely and left every
  // route outside this one with `request.body === undefined` (`/auth/login` answered 422 to a valid
  // password, and the rate limiter's per-account bucket collapsed to one shared "unknown" bucket).
  // Two anonymous wrapper layers keep Nest's own parser, which then skips a body this one already
  // read.
  //
  // Mounted after `enableCors` on purpose: a request refused here — too large, or malformed — is
  // answered by this middleware, and the browser needs the CORS headers to be able to read that
  // answer at all in the documented cross-origin deployment.
  mountLargeBodyParser(app, {
    path: '/api/v1/projects/:projectId/mockups',
    limitBytes: MAX_MOCKUP_REQUEST_BYTES,
    tooLargeMessage: (megabytes) =>
      `请求体超过 ${megabytes} MB 上限。图片本身最多 ` +
      `${Math.round(MAX_MOCKUP_BYTES / 1024 / 1024)} MB（base64 后约 1.37 倍），标记的 text/note 与图片共用这 ` +
      `${megabytes} MB：图片或标记描述太大时都会到这里。`,
    tooLargeDetails: { limitBytes: MAX_MOCKUP_REQUEST_BYTES, imageLimitBytes: MAX_MOCKUP_BYTES },
  });
  mountLargeBodyParser(app, {
    path: '/api/v1/sync/scans',
    limitBytes: MAX_SCAN_REQUEST_BYTES,
    tooLargeMessage: (megabytes) =>
      `仓库扫描的请求体超过 ${megabytes} MB 上限。一次上传最多 ${env.SYNC_MAX_ENTRIES_PER_BATCH ?? 20000} 条词条，` +
      `超出的部分要分批：带上 partial=true 再传下一批（分批上传时平台才知道没传的那些不是被删了）。`,
    tooLargeDetails: { limitBytes: MAX_SCAN_REQUEST_BYTES, maxEntriesPerBatch: env.SYNC_MAX_ENTRIES_PER_BATCH ?? 20000 },
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? env.API_PORT ?? 3001), '0.0.0.0');
  Logger.log(`LocaleHub API listening on :${process.env.API_PORT ?? env.API_PORT ?? 3001}/api/v1`, 'Bootstrap');
}

/**
 * `TRUST_PROXY` accepts `true`/`false` (a hop count is also common). Defaults to off.
 */
function parseTrustProxy(value: string): boolean | number {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : false;
}

bootstrap().catch((error) => {
  console.error('API failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
