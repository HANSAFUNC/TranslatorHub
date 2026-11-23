import { describe, expect, it, vi } from 'vitest';

import { createProvider, PiProvider } from '../ai';

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

  it('is chosen by name, with no key of its own', async () => {
    // Unlike anthropic/ollama, there is nothing to configure for the provider to be *selected* — the
    // credentials belong to the machine's pi, not to the platform.
    const before = process.env.AI_DEFAULT_POLICY;
    try {
      process.env.AI_DEFAULT_POLICY = 'pi';
      expect(createProvider().id).toBe('pi');
    } finally {
      if (before === undefined) delete process.env.AI_DEFAULT_POLICY;
      else process.env.AI_DEFAULT_POLICY = before;
    }
  });

  it('still falls back to the offline provider when nothing is chosen', () => {
    const before = process.env.AI_DEFAULT_POLICY;
    try {
      delete process.env.AI_DEFAULT_POLICY;
      expect(createProvider().id).toBe('heuristic');
    } finally {
      if (before !== undefined) process.env.AI_DEFAULT_POLICY = before;
    }
  });
});

describe('a policy that is not a provider', () => {
  it('falls back to the heuristic loudly, once, and names the value', async () => {
    // `hybrid` — the value the environment template shipped with — is not a provider. It fell through
    // every branch into the offline heuristic without saying anything, so a deployment could believe
    // it had AI drafting while "translation" was a glossary substitution over the source text.
    vi.resetModules();
    process.env.AI_DEFAULT_POLICY = 'hybrid';
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { createProvider: fresh } = await import('../ai');
      expect(fresh().id).toBe('heuristic');
      // Once, not per call: this runs on every draft request.
      expect(fresh().id).toBe('heuristic');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('hybrid');
      expect(warnings[0]).toContain('heuristic');
    } finally {
      spy.mockRestore();
      delete process.env.AI_DEFAULT_POLICY;
      vi.resetModules();
    }
  });

  it('says which prerequisite is missing when the name is real', async () => {
    vi.resetModules();
    process.env.AI_DEFAULT_POLICY = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { createProvider: fresh } = await import('../ai');
      expect(fresh().id).toBe('heuristic');
      expect(warnings[0]).toContain('ANTHROPIC_API_KEY');
    } finally {
      spy.mockRestore();
      delete process.env.AI_DEFAULT_POLICY;
      vi.resetModules();
    }
  });

  it('says nothing when the heuristic is what was asked for', async () => {
    vi.resetModules();
    process.env.AI_DEFAULT_POLICY = 'heuristic';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { createProvider: fresh } = await import('../ai');
      expect(fresh().id).toBe('heuristic');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      delete process.env.AI_DEFAULT_POLICY;
      vi.resetModules();
    }
  });
});
