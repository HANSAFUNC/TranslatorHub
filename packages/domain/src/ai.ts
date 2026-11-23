
import { pathToFileURL } from 'node:url';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { ErrorCode, LocaleHubError, Role } from '@localehub/contracts';
import { emitProjectEvent } from './events';
import { resolveGlossary, termTarget } from './glossary';
import { upsertTranslation } from './translation-core';
import type { PrismaClient } from '@prisma/client';
import { TenantPrisma } from '@localehub/database';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AiProvider {
  id: string;
  translate(input: {
    text: string;
    sourceLocale: string;
    targetLocale: string;
    /**
     * The terms that apply, with the parts that change how they are obeyed.
     *
     * `caseSensitive` and `forbidden` used to be dropped here — the pair `term => translation` was all a
     * provider ever saw — which quietly turned a rule with conditions into an unconditional one.
     */
    glossary?: { term: string; translation: string; caseSensitive?: boolean; forbidden?: string[] }[];
  }): Promise<{ text: string; provider: string; confidence: number }>;
  review(input: { source: string; target: string; targetLocale: string }): Promise<{ issues: { code: string; message: string; severity: 'ERROR' | 'WARNING' | 'INFO' }[]; provider: string }>;
}

/**
 * A term as a provider should read it: the mapping, then the conditions that change it.
 *
 * Kept in one place because the conditions are the part that gets dropped when each provider writes its
 * own line — a case-sensitive term presented as a plain pair tells the model something untrue.
 */
export function formatGlossary(glossary: { term: string; translation: string; caseSensitive?: boolean; forbidden?: string[] }[]): string {
  return glossary
    .map((entry) => {
      const notes: string[] = [];
      if (entry.caseSensitive) notes.push('case-sensitive');
      if (entry.forbidden?.length) notes.push(`never: ${entry.forbidden.join(', ')}`);
      return `${entry.term} => ${entry.translation}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    })
    .join('\n');
}

/**
 * Provider registry. The heuristic provider is offline and deterministic, which keeps the
 * demo and the test-suite independent of network access. Anthropic / OpenAI / Ollama
 * providers are wired but only activate when their API key is configured.
 */
interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: {
      prompt(text: string, options?: Record<string, unknown>): Promise<void>;
      getLastAssistantText(): string | undefined;
      dispose(): void;
    };
  }>;
  ModelRuntime: {
    create(options?: Record<string, unknown>): Promise<{
      getModel(providerId: string, modelId: string): unknown;
      getAvailable(): Promise<readonly unknown[]>;
    }>;
  };
  SessionManager: { inMemory(cwd?: string): unknown };
}

/**
 * A real dynamic `import()`, kept out of the compiler's reach.
 *
 * This package builds as CommonJS, which rewrites `await import(x)` into `require(x)` — and the pi SDK
 * is ESM with an `exports` map that defines no `require` entry, so the rewritten call is a coin flip
 * that lands heads or tails depending on the Node version. The specifier lives in a string so the
 * import stays a genuine one.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/**
 * Where to load the SDK from.
 *
 * `PI_SDK_PATH` first, because the honest answer for most machines is "the `pi` already installed
 * globally here" rather than a second copy: the package is ~150 MB (it ships the whole terminal
 * agent), it is deliberately **not** a dependency of this workspace, and nothing in a fresh checkout
 * would install it. Pointing at the installation that already exists is both cheaper and the only
 * route that works without one.
 *
 * A directory means the package directory: `dist/index.js` is what its `exports.import` names, and
 * spelling that out here is the price of loading from a path without re-implementing Node's
 * resolution. A file path is used as given.
 */
export function piSdkSpecifier(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_SDK_PATH?.trim();
  if (!explicit) return '@earendil-works/pi-coding-agent';
  const entry = explicit.endsWith('.js') || explicit.endsWith('.mjs') ? explicit : join(explicit, 'dist', 'index.js');
  return pathToFileURL(entry).href;
}

/** Loads the SDK. Absence is explained where it surfaces, in `PiProvider.complete`. */
async function loadPiSdk(): Promise<PiSdk> {
  return (await dynamicImport(piSdkSpecifier())) as PiSdk;
}

/**
 * Translation and review through `pi`, the terminal agent's own SDK.
 *
 * It exists because the machine that runs the platform already has pi configured — its own providers,
 * its own credentials, its own model catalogue — so there is no second key to hand out and no second
 * bill. It needs care for the same reason: this is the one provider here that runs *a model with an
 * agent runtime behind it* rather than a bare completion, so the call is built to take its teeth out
 * first.
 *
 *   - `noTools: 'all'` — no tools at all. The string being translated is data; there is no file to read
 *     and no command to run that it should be able to talk the model into.
 *   - `expandPromptTemplates: false` — a slash-command or skill name inside a string must not be
 *     interpreted as one.
 *   - a throwaway working directory — no AGENTS.md, no project settings, nothing discovered from
 *     wherever the API happens to be running.
 *   - a deadline, and `dispose()` in a `finally`: an agent that hangs must not hold the request open.
 *
 * The SDK is an *optional* dependency, loaded on first use, so a deployment that does not choose this
 * provider neither installs an agent runtime nor pays for it at boot.
 */
export class PiProvider implements AiProvider {
  readonly id = 'pi';

  constructor(
    private readonly options: {
      /** `provider/model` as pi's catalogue names them — `gpt-61-sol` / `ctyun/glm-5.3-flash`. */
      provider?: string;
      model?: string;
      /** Where pi keeps `auth.json` / `models.json`. Defaults to pi's own (`~/.pi/agent`). */
      agentDir?: string;
      timeoutMs?: number;
      /** Injected by tests, so the missing-SDK path is exercised without uninstalling anything. */
      load?: () => Promise<PiSdk>;
    } = {},
  ) {}

  private async complete(system: string, user: string): Promise<string> {
    // Any loader failure becomes the same sentence: an unresolved module three frames down says
    // "MODULE_NOT_FOUND" and leaves the operator to guess which of several providers asked for it.
    const sdk = await (this.options.load ?? loadPiSdk)().catch((cause: unknown) => {
      throw new LocaleHubError(
        ErrorCode.INTERNAL_ERROR,
        'The "pi" AI provider is selected but the @earendil-works/pi-coding-agent SDK could not be loaded. Point ' +
          'PI_SDK_PATH at the pi installation already on this machine (its package directory, e.g. ' +
          '`$(npm root -g)/@earendil-works/pi-coding-agent`), or install it here, or choose a different provider ' +
          'with AI_DEFAULT_POLICY.',
        500,
        { provider: 'pi', cause: cause instanceof Error ? cause.message : String(cause) },
      );
    });
    const agentDir = this.options.agentDir;
    const runtime = await sdk.ModelRuntime.create({
      refreshOnCreate: false,
      ...(agentDir ? { authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') } : {}),
    });

    const model =
      this.options.provider && this.options.model
        ? runtime.getModel(this.options.provider, this.options.model)
        : (await runtime.getAvailable())[0];
    if (!model) {
      throw new LocaleHubError(
        ErrorCode.INTERNAL_ERROR,
        this.options.provider && this.options.model
          ? `pi has no model ${this.options.provider}/${this.options.model}. Check \`pi list\` or the models.json it reads.`
          : 'pi has no model with usable credentials. Set PI_PROVIDER and PI_MODEL, or run `pi auth login`.',
        502,
      );
    }

    // A directory with nothing in it, so no project resource can reach the model.
    const cwd = mkdtempSync(join(tmpdir(), 'localehub-pi-'));
    try {
      const { session } = await sdk.createAgentSession({
        cwd,
        model,
        modelRuntime: runtime,
        noTools: 'all',
        sessionManager: sdk.SessionManager.inMemory(cwd),
      });
      try {
        await withDeadline(
          session.prompt(`${system}\n\n${user}`, { expandPromptTemplates: false }),
          this.options.timeoutMs ?? 90_000,
        );
        return (session.getLastAssistantText() ?? '').trim();
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  async translate(input: { text: string; sourceLocale: string; targetLocale: string; glossary?: { term: string; translation: string }[] }) {
    const glossary = formatGlossary(input.glossary ?? []);
    const text = await this.complete(
      'You are a professional software localisation engine. Return only the translated string, preserving every placeholder and markup token exactly.',
      `Source (${input.sourceLocale}) -> Target (${input.targetLocale})\n${glossary ? `Glossary:\n${glossary}\n` : ''}\n${input.text}`,
    );
    return { text, provider: this.id, confidence: 0.75 };
  }

  async review(input: { source: string; target: string; targetLocale: string }) {
    const raw = await this.complete(
      'You review software translations. Reply with JSON: {"issues":[{"code":"...","message":"...","severity":"ERROR|WARNING|INFO"}]}.',
      `Source: ${input.source}\nTarget (${input.targetLocale}): ${input.target}`,
    );
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as {
        issues: { code: string; message: string; severity: 'ERROR' | 'WARNING' | 'INFO' }[];
      };
      return { issues: parsed.issues ?? [], provider: this.id };
    } catch {
      // A model that answered in prose is not a review. Said plainly rather than thrown as a parse error.
      return { issues: [{ code: 'AI_UNPARSEABLE', message: raw.slice(0, 500), severity: 'INFO' as const }], provider: this.id };
    }
  }
}

/** Rejects rather than letting an agent run hold a request open forever. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocaleHubError(ErrorCode.INTERNAL_ERROR, `pi did not answer within ${ms} ms`, 504)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * The provider.
 *
 * There is one. `anthropic`, `ollama` and the offline `heuristic` were removed rather than kept as
 * options: the platform runs on a machine that already has `pi` configured, so a second key to hand
 * out and a second bill to explain bought nothing — and the heuristic in particular was worse than
 * nothing, because a "translation" that returns the source text with the glossary substituted looks
 * like output. A deployment without `pi` now gets an error naming what is missing, which is the
 * honest answer to "why is nothing translated".
 *
 * `kind` survives for the request-level override; anything but `pi` is refused by name rather than
 * quietly served by a different model.
 */
export function createProvider(kind?: string): AiProvider {
  const requested = kind ?? 'pi';
  if (requested !== 'pi') {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown AI provider "${requested}": pi is the only one this platform has.`,
      400,
      { provider: requested },
    );
  }
  return new PiProvider({
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    agentDir: process.env.PI_AGENT_DIR,
    ...(process.env.PI_TIMEOUT_MS ? { timeoutMs: Number(process.env.PI_TIMEOUT_MS) } : {}),
  });
}

export class AiService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tenant = new TenantPrisma(prisma),
  ) {}

  async draftTranslations(
    actor: ActorContext,
    projectId: string,
    input: { entryIds: string[]; targetLocales: string[]; provider?: string; writeDrafts: boolean },
  ) {
    assertRole(actor, projectId, Role.PRODUCT_MANAGER);
    const provider = createProvider(input.provider);
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { sourceLocale: true } });
      const entries = await tx.translationEntry.findMany({
        where: { id: { in: input.entryIds }, projectId },
        include: { key: { include: { sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
      });
      // Through the resolver, so a project term overrides the organisation's rather than being offered
      // alongside it — a model given both readings of one word picks whichever it prefers.
      const glossary = await resolveGlossary(tx, { organizationId: actor.organizationId, projectId });
      const results: { entryId: string; key: string; locale: string; value: string; provider: string; written: boolean }[] = [];

      for (const entry of entries) {
        const source = entry.key.sourceVersions[0]?.value ?? '';
        if (!source) continue;
        for (const locale of input.targetLocales) {
          const glossaryPairs = glossary
            .map((term) => ({ term, translation: termTarget(term, locale) }))
            .filter((pair): pair is { term: (typeof glossary)[number]; translation: string } => pair.translation !== null)
            .map((pair) => ({
              term: pair.term.term,
              translation: pair.translation,
              caseSensitive: pair.term.caseSensitive,
              forbidden: pair.term.forbiddenTargets?.[locale] ?? [],
            }));
          const { text } = await provider.translate({
            text: source,
            sourceLocale: project.sourceLocale,
            targetLocale: locale,
            glossary: glossaryPairs,
          });
          let written = false;
          if (input.writeDrafts) {
            const localeRow = await tx.locale.upsert({
              where: { projectId_code: { projectId, code: locale } },
              create: { organizationId: actor.organizationId, projectId, code: locale, name: locale },
              update: {},
            });
            await upsertTranslation(tx, {
              organizationId: actor.organizationId,
              projectId,
              keyId: entry.keyId,
              localeId: localeRow.id,
              localeCode: locale,
              value: text,
              // AI output is a DRAFT; approval is a human decision (spec §0.3).
              status: 'DRAFT',
              basedOnSourceVersionId: entry.key.sourceVersions[0]?.id ?? null,
              authorId: actor.userId,
              authorType: 'ai',
              comment: `AI draft from provider ${provider.id}`,
            });
            await emitProjectEvent(tx, {
              organizationId: actor.organizationId,
              projectId,
              eventType: 'TRANSLATION_UPDATED',
              resourceType: 'translation_entry',
              resourceId: entry.id,
              payload: { entryId: entry.id, key: entry.key.key, locale, platform: entry.key.platform, status: 'DRAFT', aiProvider: provider.id },
              actorId: actor.userId,
              actorType: 'user',
            });
            written = true;
          }
          results.push({ entryId: entry.id, key: entry.key.key, locale, value: text, provider: provider.id, written });
        }
      }
      return { provider: provider.id, results };
    });
  }

  async reviewSuggestions(actor: ActorContext, projectId: string, entryIds: string[]) {
    assertRole(actor, projectId, Role.REVIEWER);
    const provider = createProvider();
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const entries = await tx.translationEntry.findMany({
        where: { id: { in: entryIds }, projectId },
        include: { key: { include: { sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
      });
      const out: { entryId: string; key: string; locale: string; issues: unknown[]; provider: string; advisory: true }[] = [];
      for (const entry of entries) {
        const review = await provider.review({
          source: entry.key.sourceVersions[0]?.value ?? '',
          target: entry.value,
          targetLocale: entry.localeCode,
        });
        out.push({
          entryId: entry.id,
          key: entry.key.key,
          locale: entry.localeCode,
          issues: review.issues,
          provider: review.provider,
          // AI review is advisory only and never changes status by itself.
          advisory: true,
        });
      }
      return out;
    });
  }
}
