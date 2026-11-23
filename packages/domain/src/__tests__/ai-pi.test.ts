import { describe, expect, it } from 'vitest';

import { createProvider, piSdkSpecifier, PiProvider } from '../ai';

/**
 * The pi provider, without a model behind it.
 *
 * Two things matter here and neither is the translation. First, this is the only provider that runs a
 * model *with an agent runtime* behind it, so the call has to be built to take its teeth out — no
 * tools, no prompt-template expansion, nothing discovered from the working directory — and that has to
 * be pinned or a later edit quietly hands an agent the filesystem. Second, the SDK is optional, so
 * choosing this provider without it installed has to say which provider was chosen and what to install
 * rather than failing as an unresolved module three frames down.
 */
interface Captured {
  options?: Record<string, unknown>;
  promptOptions?: Record<string, unknown>;
  disposed?: boolean;
}

function fakeSdk(captured: Captured) {
  return {
    createAgentSession: async (options: Record<string, unknown>) => {
      captured.options = options;
      return {
        session: {
          prompt: async (_text: string, promptOptions?: Record<string, unknown>) => {
            captured.promptOptions = promptOptions;
          },
          getLastAssistantText: () => '  Start learning  ',
          dispose: () => {
            captured.disposed = true;
          },
        },
      };
    },
    ModelRuntime: {
      create: async () => ({
        getModel: (provider: string, model: string) => ({ provider, id: model }),
        getAvailable: async () => [],
      }),
    },
    SessionManager: { inMemory: () => ({}) },
  };
}

describe('the pi provider', () => {
  it('runs the model with no tools, no template expansion, and its own working directory', async () => {
    const captured: Captured = {};
    const provider = new PiProvider({
      provider: 'gpt-61-sol',
      model: 'ctyun/glm-5.3-flash',
      load: async () => fakeSdk(captured),
    });
    const result = await provider.translate({ text: '去学习', sourceLocale: 'zh-CN', targetLocale: 'en-US' });

    // The teeth: an agent runtime asked to translate a string must not be able to act on it.
    expect(captured.options?.noTools).toBe('all');
    expect(captured.promptOptions?.expandPromptTemplates).toBe(false);
    // Its own empty directory, so no AGENTS.md or project setting reaches the model.
    expect(typeof captured.options?.cwd).toBe('string');
    expect(captured.options?.cwd).not.toBe(process.cwd());
    // And the session is not left open behind the response.
    expect(captured.disposed).toBe(true);
    // The text is trimmed: a model that pads its answer should not put whitespace into a translation.
    expect(result).toMatchObject({ text: 'Start learning', provider: 'pi' });
  });

  it('names itself and the install command when the SDK is not there', async () => {
    const provider = new PiProvider({
      load: async () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    await expect(provider.translate({ text: 'a', sourceLocale: 'zh-CN', targetLocale: 'en-US' })).rejects.toThrow(
      /pi.*pi-coding-agent/s,
    );
  });

  it('needs no key of its own, and no policy to select it', () => {
    // There is nothing to configure for the provider to be *selected* — the credentials belong to the
    // machine's pi, not to the platform. (There used to be an `AI_DEFAULT_POLICY` to name one of
    // several; with one provider left it went with the others.)
    expect(createProvider().id).toBe('pi');
  });
});

describe('the only provider there is', () => {
  it('is pi, with no policy to configure', async () => {
    process.env.PI_PROVIDER = 'gpt-61-sol';
    process.env.PI_MODEL = 'ctyun/glm-5.3-flash';
    try {
      expect(createProvider().id).toBe('pi');
    } finally {
      delete process.env.PI_PROVIDER;
      delete process.env.PI_MODEL;
    }
  });

  it('refuses a provider it does not have, by name', () => {
    // `anthropic`, `ollama` and the offline heuristic used to be options. A caller still asking for one
    // is told the truth rather than served by a different model — and a deployment that used to run on
    // the heuristic now gets an error instead of "translations" that were the source text back.
    for (const gone of ['anthropic', 'ollama', 'heuristic', 'hybrid', 'openai']) {
      expect(() => createProvider(gone), gone).toThrowError(/pi is the only one/);
    }
  });
});

describe('where the SDK is loaded from', () => {
  it('uses the bare specifier by default', () => {
    // Nothing declares the dependency, so a workspace install only has it if somebody added it by
    // hand; the container image mounts it into node_modules. Both routes go through the specifier.
    expect(piSdkSpecifier({})).toBe('@earendil-works/pi-coding-agent');
  });

  it('loads from the pi installation this machine already has, when told where it is', () => {
    // The package is ~150 MB and ships a whole terminal agent. A machine that already runs `pi` has
    // it, and pointing at that copy beats installing a second one — which is what this is for.
    expect(piSdkSpecifier({ PI_SDK_PATH: '/opt/pi/pi-coding-agent' })).toBe('file:///opt/pi/pi-coding-agent/dist/index.js');
  });

  it('takes a file path as given', () => {
    expect(piSdkSpecifier({ PI_SDK_PATH: '/opt/pi/dist/index.mjs' })).toBe('file:///opt/pi/dist/index.mjs');
  });

  it('ignores a blank value', () => {
    expect(piSdkSpecifier({ PI_SDK_PATH: '   ' })).toBe('@earendil-works/pi-coding-agent');
  });
});
