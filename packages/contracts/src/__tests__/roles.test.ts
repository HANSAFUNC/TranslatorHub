import { describe, expect, it } from 'vitest';
import { Role, roleMeets } from '../roles';

/**
 * The ranking, used from both sides.
 *
 * `roleMeets` exists because the web pages have to decide whether to offer a destructive button, and
 * the API decides whether to allow the request — with the same comparison, against the same role the
 * list endpoint reports. The time this went wrong it was two lists of "roles that may delete" that
 * were allowed to drift; pinning the comparison pins both the guard and the button.
 */
describe('ranking roles', () => {
  it('orders the roles the way the guards rely on', () => {
    expect(roleMeets(Role.PLATFORM_ADMIN, Role.ORG_OWNER)).toBe(true);
    expect(roleMeets(Role.ORG_OWNER, Role.ORG_ADMIN)).toBe(true);
    expect(roleMeets(Role.ORG_ADMIN, Role.PROJECT_MANAGER)).toBe(true);
    expect(roleMeets(Role.PROJECT_MANAGER, Role.DEVELOPER)).toBe(true);
    expect(roleMeets(Role.DEVELOPER, Role.PROJECT_MANAGER)).toBe(false);
    expect(roleMeets(Role.READONLY, Role.PROJECT_MANAGER)).toBe(false);
  });

  it('treats the minimum itself as allowed', () => {
    for (const role of Object.values(Role)) {
      expect(roleMeets(role, role), role).toBe(true);
    }
  });

  it('answers false for nothing, for an empty string, and for a role it does not know', () => {
    // An unknown string is what a stale client sends after a role is renamed — it must not be read
    // as a permission just because it is truthy.
    expect(roleMeets(null, Role.READONLY)).toBe(false);
    expect(roleMeets(undefined, Role.READONLY)).toBe(false);
    expect(roleMeets('', Role.READONLY)).toBe(false);
    expect(roleMeets('SUPERUSER', Role.READONLY)).toBe(false);
  });
});