-- The AI provider is `pi`, configured by the environment (`PI_*`), not by a row.
--
-- This table never had a writer: one route listed its rows, nothing read them to build a provider,
-- and it was empty. What it did do was advertise five kinds of provider — anthropic, openai,
-- azure_openai, ollama, custom — that a deployer could reasonably read as available. Dropping it is
-- how the schema stops saying that. Any row it held was inert: nothing in the product read it.
DROP TABLE IF EXISTS "ai_provider_configs";

DROP TYPE IF EXISTS "AiProviderKind";
