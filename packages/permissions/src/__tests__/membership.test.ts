import { describe, expect, it } from 'vitest';
import { Role, roleMeets } from '@localehub/contracts';

import {
  assertCanGrantOrgRole,
  assertCanManageMember,
  assertCanManageMembers,
  canGrantOrgRole,
  canManageMember,
  canManageMembers,
  highestRole,
} from '../index';
import type { ActorContext } from '../index';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'user',
    userId: 'actor-1',
    organizationId: 'org-1',
    orgRole: Role.ORG_ADMIN,
    projectRoles: {},
    scopes: [],
    ...overrides,
  };
}

/**
 * Member-management authorization.
 *
 * These are privilege-escalation guards, not conveniences: each one, if it regressed, would let a
 * lower role quietly become a higher one. The service tests cover the last-owner rule, which needs
 * a database; everything decidable from the actor alone is here.
 */

describe('who may manage members', () => {
  it('allows owners, admins and platform admins', () => {
    expect(canManageMembers(actor({ orgRole: Role.ORG_OWNER }))).toBe(true);
    expect(canManageMembers(actor({ orgRole: Role.ORG_ADMIN }))).toBe(true);
    expect(canManageMembers(actor({ orgRole: Role.READONLY, isPlatformAdmin: true }))).toBe(true);
  });

  it('refuses every role below admin, even a project manager', () => {
    for (const role of [Role.PROJECT_MANAGER, Role.TRANSLATOR, Role.REVIEWER, Role.DEVELOPER, Role.READONLY]) {
      expect(canManageMembers(actor({ orgRole: role }))).toBe(false);
    }
    // A project role is scoped to one project and must not widen into organization membership.
    expect(
      canManageMembers(actor({ orgRole: Role.DEVELOPER, projectRoles: { 'project-1': Role.PROJECT_MANAGER } })),
    ).toBe(false);
  });

  it('refuses an MCP token regardless of the org role attached to it', () => {
    // A leaked token must not be able to grow its own access by editing memberships.
    expect(canManageMembers(actor({ kind: 'mcp', orgRole: Role.ORG_OWNER }))).toBe(false);
    expect(() => assertCanManageMembers(actor({ kind: 'mcp', orgRole: Role.ORG_OWNER }))).toThrow(/MCP tokens/);
  });

  it('reports the required role on refusal', () => {
    try {
      assertCanManageMembers(actor({ orgRole: Role.DEVELOPER }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code: string }).code).toBe('ROLE_INSUFFICIENT');
      expect((error as { details: { required: string } }).details.required).toBe(Role.ORG_ADMIN);
    }
  });
});

describe('which roles may be granted', () => {
  it('lets an owner grant an owner', () => {
    expect(canGrantOrgRole(actor({ orgRole: Role.ORG_OWNER }), Role.ORG_OWNER)).toBe(true);
  });

  it('stops an admin from minting an owner', () => {
    // Otherwise the hierarchy is decorative: an admin appoints an owner, then uses that account.
    expect(canGrantOrgRole(actor({ orgRole: Role.ORG_ADMIN }), Role.ORG_OWNER)).toBe(false);
    expect(() => assertCanGrantOrgRole(actor({ orgRole: Role.ORG_ADMIN }), Role.ORG_OWNER)).toThrow(/outranks/);
  });

  it('lets an admin grant anything at or below admin', () => {
    for (const role of [Role.ORG_ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER, Role.TRANSLATOR, Role.READONLY]) {
      expect(canGrantOrgRole(actor({ orgRole: Role.ORG_ADMIN }), role)).toBe(true);
    }
  });

  it('lets a platform admin grant any role', () => {
    expect(canGrantOrgRole(actor({ orgRole: null, isPlatformAdmin: true }), Role.ORG_OWNER)).toBe(true);
  });
});

describe('which members may be modified', () => {
  it('stops an admin from demoting or removing an owner', () => {
    // The mirror of the grant rule: an admin must not be able to unseat the owner who appointed them.
    expect(canManageMember(actor({ orgRole: Role.ORG_ADMIN }), Role.ORG_OWNER)).toBe(false);
    expect(() => assertCanManageMember(actor({ orgRole: Role.ORG_ADMIN }), Role.ORG_OWNER)).toThrow(/outranks/);
  });

  it('lets an owner manage an admin, and an admin manage their peers', () => {
    expect(canManageMember(actor({ orgRole: Role.ORG_OWNER }), Role.ORG_ADMIN)).toBe(true);
    expect(canManageMember(actor({ orgRole: Role.ORG_ADMIN }), Role.ORG_ADMIN)).toBe(true);
  });

  it('lets an admin manage members below them', () => {
    expect(canManageMember(actor({ orgRole: Role.ORG_ADMIN }), Role.DEVELOPER)).toBe(true);
    expect(canManageMember(actor({ orgRole: Role.ORG_ADMIN }), Role.READONLY)).toBe(true);
  });
});

/**
 * The ranking itself, now shared with the browser.
 *
 * `ROLE_WEIGHT` moved to `@localehub/contracts/roles` so a web page can ask "may this role delete a
 * project?" without re-stating the order, and `highestRole`/`roleMeets` below are the two halves of
 * what `assertRole` does. If these ever disagreed with the guard, the project list would offer a
 * delete button to someone the API refuses — or hide it from someone who is allowed.
 */
describe('ranking roles', () => {
  it('picks the stronger of the org and project roles, and stops at the project role', () => {
    const effective = (orgRole: Role | null, projectRole: Role | null) => highestRole([orgRole, projectRole]);

    expect(effective(Role.DEVELOPER, Role.PROJECT_MANAGER)).toBe(Role.PROJECT_MANAGER);
    expect(effective(Role.ORG_OWNER, Role.READONLY)).toBe(Role.ORG_OWNER);
    expect(effective(null, Role.TRANSLATOR)).toBe(Role.TRANSLATOR);
    expect(effective(null, null)).toBeNull();
  });

  it('agrees with the comparison the delete guard uses', () => {
    // `assertRole(…, PROJECT_MANAGER)` is `roleMeets(highestRole([org, project]), PROJECT_MANAGER)`.
    const mayDelete = (orgRole: Role | null, projectRole: Role | null) =>
      roleMeets(highestRole([orgRole, projectRole]), Role.PROJECT_MANAGER);

    expect(mayDelete(Role.ORG_OWNER, null)).toBe(true);
    expect(mayDelete(Role.DEVELOPER, Role.PROJECT_MANAGER)).toBe(true);
    expect(mayDelete(Role.DEVELOPER, null)).toBe(false);
    expect(mayDelete(Role.TRANSLATOR, Role.REVIEWER)).toBe(false);
    expect(mayDelete(Role.READONLY, null)).toBe(false);
    expect(mayDelete(null, null)).toBe(false);
  });
});
