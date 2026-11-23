import { Role, roleMeets } from '@localehub/contracts/roles';

/**
 * Whether this role may delete a project.
 *
 * The API decides with `assertRole(actor, projectId, PROJECT_MANAGER)` — the ranking comparison in
 * `@localehub/contracts/roles`, against the *effective* role (the stronger of the caller's
 * organization role and their role on this project), which is exactly the value `GET /projects` and
 * `GET /projects/:id` report back as `role`.
 *
 * So this is not a list of roles that happen to be allowed; it is the same comparison, against the
 * same single ranking, which is what keeps the page from contradicting the API. The two failure
 * modes of a second copy — a button offered to somebody the API refuses, and a destructive action
 * withheld from somebody it would have allowed — are both invisible until a user hits them.
 *
 * `@localehub/contracts/roles` and not the package root: the root reaches `node:crypto` through its
 * hashing helpers and will not bundle for the browser.
 */
export function canDeleteProject(role: string | null | undefined): boolean {
  return roleMeets(role, Role.PROJECT_MANAGER);
}
