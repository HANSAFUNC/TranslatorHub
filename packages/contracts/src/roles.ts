/** Spec §2.1 roles. */
export const Role = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  ORG_OWNER: 'ORG_OWNER',
  ORG_ADMIN: 'ORG_ADMIN',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  DEVELOPER: 'DEVELOPER',
  PRODUCT_MANAGER: 'PRODUCT_MANAGER',
  TRANSLATOR: 'TRANSLATOR',
  REVIEWER: 'REVIEWER',
  READONLY: 'READONLY',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ORG_ROLES: Role[] = [Role.ORG_OWNER, Role.ORG_ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER, Role.PRODUCT_MANAGER, Role.TRANSLATOR, Role.REVIEWER, Role.READONLY];
export const PROJECT_ROLES: Role[] = [Role.PROJECT_MANAGER, Role.DEVELOPER, Role.PRODUCT_MANAGER, Role.TRANSLATOR, Role.REVIEWER, Role.READONLY];

/**
 * The ranking every "this role or higher" decision is made by — the API's `assertRole`, and the web
 * pages that have to decide whether to offer a button at all.
 *
 * It lives next to the role names, in the one module the browser can import (`@localehub/contracts/roles`
 * is pure; the package root reaches `node:crypto` and cannot be bundled). A page that re-states the
 * order — "may delete = owner, admin, project manager" — is a second copy of this rule, and the copy
 * that drifts is the one nobody is looking at: a button offered to somebody the API refuses, or a
 * destructive action withheld from somebody it would have allowed.
 */
export const ROLE_WEIGHT: Record<Role, number> = {
  [Role.PLATFORM_ADMIN]: 100,
  [Role.ORG_OWNER]: 90,
  [Role.ORG_ADMIN]: 80,
  [Role.PROJECT_MANAGER]: 60,
  [Role.PRODUCT_MANAGER]: 50,
  [Role.REVIEWER]: 40,
  [Role.TRANSLATOR]: 30,
  [Role.DEVELOPER]: 20,
  [Role.READONLY]: 10,
};

/**
 * Whether `role` is at least `minimum`. Takes a plain string because the value arrives from the API
 * as one, and answers false for anything it does not recognise — an unknown role is not a permission,
 * and the roles have grown before now.
 */
export function roleMeets(role: string | null | undefined, minimum: Role): boolean {
  if (!role) return false;
  const weight = ROLE_WEIGHT[role as Role];
  return weight !== undefined && weight >= ROLE_WEIGHT[minimum];
}

/** Spec §2.2 — MCP token scopes. Kept deliberately fine grained. */
export const McpScope = {
  PROJECT_READ: 'project.read',
  REPOSITORY_SCAN: 'repository.scan',
  SYNC_PREVIEW: 'sync.preview',
  SYNC_PUSH: 'sync.push',
  TRANSLATION_READ: 'translation.read',
  TRANSLATION_WRITE: 'translation.write',
  TRANSLATION_PULL: 'translation.pull',
  TRANSLATION_APPLY: 'translation.apply',
  TRANSLATION_REVIEW: 'translation.review',
  QA_EXECUTE: 'qa.execute',
  GLOSSARY_READ: 'glossary.read',
  /**
   * Proposing terms. Deliberately separate from reading them, and deliberately *not* in the default
   * token: a term a company fixed is an instruction every future translation has to follow, so the
   * right to add one is a right somebody grants on purpose.
   */
  GLOSSARY_WRITE: 'glossary.write',
  RELEASE_PUBLISH: 'release.publish',
  ADMIN: 'admin',
} as const;
export type McpScope = (typeof McpScope)[keyof typeof McpScope];

export const ALL_MCP_SCOPES: McpScope[] = Object.values(McpScope);

/**
 * Default scope set for a freshly issued developer token: read + scan + preview + push,
 * but *not* translation.apply and never release.publish (spec §2.2 requires explicit
 * separation between pushing local changes and writing platform changes into a repo).
 */
export const DEFAULT_MCP_SCOPES: McpScope[] = [
  McpScope.PROJECT_READ,
  McpScope.REPOSITORY_SCAN,
  McpScope.SYNC_PREVIEW,
  McpScope.SYNC_PUSH,
  McpScope.TRANSLATION_READ,
  McpScope.TRANSLATION_PULL,
  McpScope.GLOSSARY_READ,
  McpScope.QA_EXECUTE,
];

export function isMcpScope(value: string): value is McpScope {
  return (ALL_MCP_SCOPES as string[]).includes(value);
}
