/**
 * Give already-imported keys the platform their files actually declared.
 *
 * Every entry used to lose its platform on the way in (`scanEntrySchema` had no such field), so
 * every key was stored as `web` whatever the caller said — an iOS project with 2,791 keys had 2,791
 * `web` keys and not one `ios` key, while its own `project_platforms` said `ios`.
 *
 * The scan records are the evidence and they are still there: each stored scan carries
 * `files[].platform`, and every entry names the `fileId` it came from. So the migration derives each
 * key's platform from the file it was read out of, rather than from a guess about the project.
 *
 * Dry run by default. `--confirm` writes, inside one transaction per project, and refuses to touch a
 * key whose evidence is ambiguous (the same key seen under two platforms) or missing.
 *
 *   node scripts/backfill-key-platform.mjs                     # report only
 *   node scripts/backfill-key-platform.mjs --project <uuid>    # one project
 *   node scripts/backfill-key-platform.mjs --confirm           # write
 *
 * Everything a key's identity touches moves together: the key row, the namespace row it is reached
 * through (`namespaces` is unique per (project, platform, name), and the push resolves a key by
 * platform *and* namespace), and the sync baseline, so the first push after the migration still
 * reports `unchanged` instead of re-creating what is already there.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolved from `apps/api`, which declares `@localehub/database`: `scripts/` has no node_modules.
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrismaClient } = await import(pathToFileURL(require.resolve('@localehub/database')).href);

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const only = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;

const prisma = new PrismaClient();

/** Run `fn` with the RLS bypass on: an operator script has no organization context to scope to. */
async function asOperator(fn) {
  // The default 5 s interactive-transaction timeout is not enough for a project with thousands of
  // keys and tens of thousands of baselines; the first run died halfway through the big one.
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      return fn(tx);
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
}

/** Postgres refuses more than 65,535 bind parameters, so the `in` lists go in chunks. */
function chunk(values, size = 5_000) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/**
 * What platform each `(namespace, key)` was read under, according to the scans on record.
 *
 * A key seen under more than one platform is reported rather than resolved: both readings are in the
 * data, and picking one would silently rewrite history.
 */
function deriveFrom(scans) {
  const seen = new Map();
  for (const scan of scans) {
    const platformOfFile = new Map((scan.files ?? []).map((file) => [file.fileId, file.platform]));
    for (const entry of scan.entries ?? []) {
      // Newer scans carry the platform on the entry; older ones only on the file it names.
      const platform = entry.platform ?? platformOfFile.get(entry.fileId);
      if (!platform) continue;
      const identity = `${entry.namespace ?? ''}\u0001${entry.key}`;
      const platforms = seen.get(identity) ?? new Set();
      platforms.add(platform);
      seen.set(identity, platforms);
    }
  }
  return seen;
}

async function planProject(tx, project) {
  const scans = await tx.syncScan.findMany({
    where: { projectId: project.id },
    select: { files: true, entries: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const evidence = deriveFrom(scans);

  const keys = await tx.translationKey.findMany({
    where: { projectId: project.id },
    select: { id: true, platform: true, key: true, namespace: { select: { id: true, name: true } } },
  });

  const moves = [];
  const ambiguous = [];
  const unevidenced = [];
  for (const key of keys) {
    const platforms = evidence.get(`${key.namespace.name}\u0001${key.key}`);
    if (!platforms) unevidenced.push(key);
    else if (platforms.size > 1) ambiguous.push({ key, platforms: [...platforms] });
    else if ([...platforms][0] !== key.platform) moves.push({ key, to: [...platforms][0] });
  }

  // Namespaces are per (project, platform, name) and the push resolves keys through them, so a key
  // that moves has to become reachable under the new platform's namespace row.
  const namespaces = new Map();
  for (const move of moves) {
    const target = `${move.to}\u0001${move.key.namespace.name}`;
    const group = namespaces.get(target) ?? { to: move.to, name: move.key.namespace.name, keys: [] };
    group.keys.push(move.key);
    namespaces.set(target, group);
  }

  const baselines = moves.length
    ? await tx.syncBaseline.findMany({
        where: {
          projectId: project.id,
          OR: moves.map((move) => ({ platform: move.key.platform, translationKey: move.key.key, namespace: move.key.namespace.name })),
        },
        select: { id: true, platform: true, namespace: true, translationKey: true },
      })
    : [];

  return { evidence, keys, moves, ambiguous, unevidenced, namespaces, baselines, scans: scans.length };
}

/**
 * A namespace row that holds no keys and whose platform no longer appears among the project's keys.
 *
 * The first migration left one behind: the keys moved to the `ios` row and the `web` row stayed,
 * empty — a phantom string table for a project that declares `ios` and nothing else. Only rows that
 * hold nothing are dropped, and the relation cascades to keys, so the count is the whole guard.
 */
async function emptyNamespaceRows(tx, project) {
  const rows = await tx.namespace.findMany({
    where: { projectId: project.id },
    select: { id: true, platform: true, name: true, _count: { select: { keys: true } } },
  });
  const platformsInUse = new Set(
    (await tx.translationKey.findMany({ where: { projectId: project.id }, select: { platform: true }, distinct: ['platform'] })).map(
      (row) => row.platform,
    ),
  );
  return rows.filter((row) => row._count.keys === 0 && !platformsInUse.has(row.platform));
}

async function applyProject(tx, project, plan) {
  const platformOfNamespace = new Map();
  for (const [target, group] of plan.namespaces) {
    let row = await tx.namespace.findUnique({
      where: { projectId_platform_name: { projectId: project.id, platform: group.to, name: group.name } },
      select: { id: true },
    });
    if (!row) {
      row = await tx.namespace.create({
        data: { organizationId: project.organizationId, projectId: project.id, platform: group.to, name: group.name },
        select: { id: true },
      });
    }
    platformOfNamespace.set(target, row.id);
  }

  // One statement per (from-platform, namespace, target) rather than one per key: 2,791 individual
  // updates plus 8,295 baseline updates is what blew the transaction's time budget.
  const groups = new Map();
  for (const move of plan.moves) {
    const groupKey = `${move.key.platform}\u0001${move.key.namespace.id}\u0001${move.to}`;
    const group = groups.get(groupKey) ?? {
      from: move.key.platform,
      namespaceId: move.key.namespace.id,
      namespaceName: move.key.namespace.name,
      to: move.to,
      keys: [],
    };
    group.keys.push(move.key.key);
    groups.set(groupKey, group);
  }

  for (const group of groups.values()) {
    // The namespace row the keys used to hang from is left behind empty: a project that declares
    // `ios` should not keep a phantom `web` string table. Dropped only when it really holds nothing —
    // the relation cascades, so a wrong count here would delete keys.

    const namespaceId = platformOfNamespace.get(`${group.to}\u0001${group.namespaceName}`) ?? group.namespaceId;
    for (const batch of chunk(group.keys)) {
      await tx.translationKey.updateMany({
        where: { projectId: project.id, platform: group.from, namespaceId: group.namespaceId, key: { in: batch } },
        data: { platform: group.to, namespaceId },
      });
      await tx.syncBaseline.updateMany({
        where: {
          projectId: project.id,
          platform: group.from,
          namespace: group.namespaceName,
          translationKey: { in: batch },
        },
        data: { platform: group.to },
      });
    }

    const remaining = await tx.translationKey.count({
      where: { projectId: project.id, namespaceId: group.namespaceId },
    });
    if (remaining === 0) {
      await tx.namespace.delete({ where: { id: group.namespaceId } });
    }
  }
}

const projects = await asOperator((tx) =>
  tx.project.findMany({
    where: only ? { id: only } : {},
    select: { id: true, name: true, organizationId: true },
    orderBy: { name: 'asc' },
  }),
);

let moved = 0;
for (const project of projects) {
  const plan = await asOperator((tx) => planProject(tx, project));
  if (!plan.keys.length) continue;

  const byTarget = new Map();
  for (const move of plan.moves) byTarget.set(move.to, (byTarget.get(move.to) ?? 0) + 1);

  console.log(`\n${project.name}  (${project.id})`);
  console.log(`  scans on record: ${plan.scans}   keys: ${plan.keys.length}`);
  if (plan.moves.length) {
    console.log(
      `  move: ${[...byTarget].map(([platform, count]) => `${count} key(s) → ${platform}`).join(', ')}` +
        `   namespaces: ${[...plan.namespaces.values()].map((group) => `'${group.name}' → ${group.to}`).join(', ')}`,
    );
    console.log(`  baselines to move: ${plan.baselines.length}`);
  } else {
    console.log('  move: nothing to do');
  }
  if (plan.ambiguous.length) {
    console.log(`  AMBIGUOUS (left alone): ${plan.ambiguous.length}`);
    for (const row of plan.ambiguous.slice(0, 5)) {
      console.log(`    ${row.key.key} — seen under ${row.platforms.join(' and ')}`);
    }
  }
  if (plan.unevidenced.length) {
    console.log(`  no scan evidence (left alone): ${plan.unevidenced.length}`);
  }

  if (!confirm) continue;
  if (plan.moves.length) {
    await asOperator((tx) => applyProject(tx, project, plan));
    moved += plan.moves.length;
    console.log(`  applied: ${plan.moves.length} key(s)`);
  }
  const emptied = await asOperator(async (tx) => {
    const rows = await emptyNamespaceRows(tx, project);
    for (const row of rows) await tx.namespace.delete({ where: { id: row.id } });
    return rows;
  });
  for (const row of emptied) console.log(`  dropped empty namespace '${row.name}' (${row.platform})`);
}

if (confirm) {
  console.log(`\nTotal keys moved: ${moved}`);
  // The property that matters afterwards: re-deriving from the same evidence finds nothing left.
  for (const project of projects) {
    const plan = await asOperator((tx) => planProject(tx, project));
    if (!plan.keys.length) continue;
    console.log(`${plan.moves.length === 0 ? 'ok  ' : 'FAIL'} ${project.name}: ${plan.moves.length} key(s) still mismatched`);
  }
} else {
  console.log('\nDry run. Re-run with --confirm to apply.');
}

await prisma.$disconnect();
