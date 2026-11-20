'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookMarked, Check, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { useAsync } from '@/components/use-async';
import { del, get, patch, post, type ProjectSummary } from '@/lib/api';
import { localeDisplayName } from '@localehub/contracts/locale';

type TermStatus = 'DRAFT' | 'APPROVED' | 'DEPRECATED';

interface ResolvedTerm {
  id: string;
  term: string;
  translations: Record<string, string>;
  caseSensitive: boolean;
  status: TermStatus;
  doNotTranslate: boolean;
  forbiddenTargets: Record<string, string[]>;
  scope: 'organization' | 'project';
  overrides?: { term: string; translations: Record<string, string> };
}

interface GlossaryPayload {
  terms: ResolvedTerm[];
  rows: { id: string; projectId: string | null; term: string; disabled: boolean; status: TermStatus }[];
  counts: { organization: number; project: number; draft: number };
}

interface Candidate {
  term: string;
  keyCount: number;
  exampleKey: string;
  /** What the project already calls it, per language, with the count that supports each answer. */
  suggestions: {
    locale: string;
    value: string;
    example: { source: string; target: string };
    support: number;
    total: number;
  }[];
  /** Every language that has an answer leaves the term alone. */
  keepAsIs: boolean;
}

/**
 * The termbase, where a translation team actually keeps one.
 *
 * It is a back-office page rather than a panel in the editor because a termbase is decided in one sitting
 * by somebody who can see all of it — which words recur, which are still candidates, which the company
 * already fixed. The editor is where a term is *obeyed*; this is where it is made.
 *
 * Two things on this page are the whole point. A term has a **state**, and only an approved one is a
 * rule: a violation of it fails the release check, while a candidate only warns. And every row says
 * whether it comes from the project or the organisation, including when a project term replaced one —
 * the disagreement used to be invisible, which is how a termbase starts contradicting itself.
 */
export default function GlossaryPage() {
  const { data: projects, error: projectsError } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [extracting, setExtracting] = useState(false);

  /**
   * The project lives in the URL, so "look at our termbase for X" is a link somebody can send.
   *
   * Read and written with the history API rather than `useSearchParams`, because this page has no server
   * component to suspend and the value never needs to reach the server.
   */
  useEffect(() => {
    if (projectId || !projects?.length) return;
    const wanted = new URLSearchParams(window.location.search).get('project');
    setProjectId(projects.some((project) => project.id === wanted) ? wanted! : projects[0]!.id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!projectId) return;
    window.history.replaceState(null, '', `?project=${encodeURIComponent(projectId)}`);
  }, [projectId]);

  const { data, error, loading, reload } = useAsync(
    () => (projectId ? get<GlossaryPayload>(`/projects/${projectId}/glossary`) : Promise.resolve(null)),
    [projectId],
  );
  const { data: detail } = useAsync(
    () => (projectId ? get<{ locales: { code: string }[] }>(`/projects/${projectId}`) : Promise.resolve(null)),
    [projectId],
  );

  const terms = data?.terms ?? [];
  // The languages this termbase actually speaks, taken from the terms themselves: a column for a locale
  // nobody has written a term in is a column of dashes.
  const locales = useMemo(() => {
    const found = new Set<string>();
    for (const term of terms) for (const code of Object.keys(term.translations)) found.add(code);
    return [...found].sort();
  }, [terms]);
  const targetLocales = (detail?.locales ?? []).map((entry) => entry.code).filter((code) => !locales.includes(code));

  /** Which translation cell is open for editing, and what is typed in it. */
  const [editing, setEditing] = useState<{ termId: string; locale: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [newTerm, setNewTerm] = useState('');
  const [newLocale, setNewLocale] = useState('');
  const [newValue, setNewValue] = useState('');

  /**
   * `done` may be a function of the result, because one of these actions has an answer worth reading:
   * approving a term queues the recheck that makes it a rule, and if the queue was unreachable the
   * person needs to be told to run it themselves rather than believe the project has been re-read.
   */
  async function run<T>(key: string, work: () => Promise<T>, done: string | ((result: T) => string)): Promise<T | null> {
    setBusy(key);
    try {
      const result = await work();
      toast.success(typeof done === 'function' ? done(result) : done);
      await reload();
      return result;
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
      return null;
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="术语库"
        description="每个项目一份属于它自己的词汇表：项目词条压过组织词条，已定稿的违反会让发布前校验不通过"
        actions={
          projects?.length ? (
            <Select value={projectId ?? undefined} onValueChange={(value) => { setProjectId(value); setCandidates(null); }}>
              {/* Named for the browser check: the page has a second select in the add form. */}
              <SelectTrigger size="sm" className="w-[220px]" data-project-picker>
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null
        }
      />

      <ErrorAlert error={error ?? projectsError} />

      {loading ? (
        <Skeleton className="h-64" />
      ) : !projects?.length ? (
        <EmptyState icon={<BookMarked />} title="还没有项目" description="术语库挂在项目下，先建一个项目。" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="生效中的词条" value={terms.length} hint="组织级与项目级合并后，一个词只算一次" />
            <Stat label="项目自己的" value={data?.counts.project ?? 0} hint="压过组织词条的也算在内" />
            <Stat label="还没定稿" value={data?.counts.draft ?? 0} hint="草稿只警告，定稿了发布前校验就不通过" />
          </div>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <CardTitle>词条</CardTitle>
                <CardDescription>
                  一个原文词只有一行答案。项目级覆盖组织级时会写出来，不让两边悄悄打架。
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-glossary-extract
                disabled={extracting || !projectId}
                onClick={async () => {
                  setExtracting(true);
                  try {
                    const result = await post<{ candidates: Candidate[]; scannedKeys: number }>(
                      `/projects/${projectId}/glossary/extract`,
                      { minKeys: 3, limit: 60 },
                    );
                    setCandidates(result.candidates);
                    toast.success(`扫了 ${result.scannedKeys} 条原文，提出 ${result.candidates.length} 个候选`);
                  } catch (failure) {
                    toast.error(failure instanceof Error ? failure.message : String(failure));
                  } finally {
                    setExtracting(false);
                  }
                }}
              >
                <Wand2 data-icon="inline-start" />
                {extracting ? '抽取中…' : '从已有译文抽候选'}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {terms.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    icon={<BookMarked />}
                    title="这个项目还没有词条"
                    description="先抽一批候选看看这个项目的词汇长什么样，或者手工加一条。"
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[16rem]">原文</TableHead>
                        {locales.map((code) => (
                          <TableHead key={code}>{code} · {localeDisplayName(code)}</TableHead>
                        ))}
                        <TableHead className="w-24">状态</TableHead>
                        <TableHead className="w-28">来源</TableHead>
                        {/* Pinned like the candidates' action column: with six languages the row is
                            wider than the screen, and the buttons have to stay reachable. */}
                        <TableHead className="bg-card sticky right-0 w-40 border-l" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {terms.map((term) => (
                        <TableRow key={term.id} data-term={term.term}>
                          <TableCell className="align-top">
                            <span className="font-medium">{term.term}</span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              {term.doNotTranslate ? (
                                <Badge variant="outline" className="text-[10px]">不翻译</Badge>
                              ) : null}
                              {term.caseSensitive ? (
                                <Badge variant="outline" className="text-[10px]">区分大小写</Badge>
                              ) : null}
                            </span>
                          </TableCell>
                          {locales.map((code) => (
                            <TableCell key={code} className="align-top text-sm">
                              {term.doNotTranslate ? (
                                <span className="text-muted-foreground">{term.term}（保持原样）</span>
                              ) : editing?.termId === term.id && editing.locale === code ? (
                                <Input
                                  autoFocus
                                  value={draft}
                                  className="h-7 w-40"
                                  onChange={(event) => setDraft(event.target.value)}
                                  onBlur={() => {
                                    // Saved on the way out, including on Escape: the alternative is a
                                    // cell that silently keeps a value nobody can see the state of.
                                    const next = draft.trim();
                                    setEditing(null);
                                    if (next === (term.translations[code] ?? '')) return;
                                    void run(
                                      `${term.id}:${code}`,
                                      () =>
                                        patch(`/projects/${projectId}/glossary/${term.id}`, {
                                          translations: { ...term.translations, ...(next ? { [code]: next } : {}) },
                                        }),
                                      `已更新 ${term.term} 的 ${code}`,
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.currentTarget.blur();
                                    if (event.key === 'Escape') {
                                      setDraft(term.translations[code] ?? '');
                                      setEditing(null);
                                    }
                                  }}
                                />
                              ) : (
                                <button
                                  type="button"
                                  // A candidate arrives with a suggested value, and a suggestion somebody
                                  // cannot correct is worse than none: this is where it gets corrected.
                                  onClick={() => {
                                    setDraft(term.translations[code] ?? '');
                                    setEditing({ termId: term.id, locale: code });
                                  }}
                                  className="hover:bg-muted -mx-1 rounded px-1 text-left hover:underline"
                                  title="点一下改这条译法"
                                >
                                  {term.translations[code] || <span className="text-muted-foreground">—</span>}
                                </button>
                              )}
                            </TableCell>
                          ))}
                          <TableCell className="align-top">
                            <StatusPill status={term.status} />
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            {term.scope === 'project' ? (
                              <span>
                                项目
                                {term.overrides ? (
                                  <span className="text-muted-foreground block">
                                    覆盖组织：{term.overrides.term}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">组织</span>
                            )}
                          </TableCell>
                          <TableCell className="bg-card sticky right-0 border-l align-top">
                            <span className="flex flex-wrap items-center gap-1">
                              {term.status === 'APPROVED' ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  data-term-status
                                  disabled={busy === term.id}
                                  onClick={() => void run(term.id, () => patch(`/projects/${projectId}/glossary/${term.id}`, { status: 'DRAFT' }), '已退回草稿')}
                                >
                                  <RotateCcw data-icon="inline-start" />
                                  退回
                                </Button>
                              ) : (
                                <Button
                                  variant={term.status === 'DRAFT' ? 'default' : 'outline'}
                                  size="sm"
                                  data-term-status
                                  disabled={busy === term.id}
                                  onClick={() =>
                                    void run(
                                      term.id,
                                      () =>
                                        patch<{ recheck?: { queued: boolean } }>(
                                          `/projects/${projectId}/glossary/${term.id}`,
                                          { status: 'APPROVED' },
                                        ),
                                      (result) =>
                                        result.recheck?.queued === false
                                          ? '已定稿，但重查没排上（队列不可用）——请手动跑一次 QA'
                                          : '已定稿——违反它现在会让发布前校验不通过，已有译文正在重查',
                                    )
                                  }
                                >
                                  <Check data-icon="inline-start" />
                                  定稿
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy === term.id}
                                onClick={() => void run(term.id, () => del(`/projects/${projectId}/glossary/${term.id}`), `已删除 ${term.term}`)}
                              >
                                <Trash2 data-icon="inline-start" />
                              </Button>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {candidates ? (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <CardTitle>候选</CardTitle>
                  <CardDescription>
                    这个项目反复出现的说法，以及<span className="text-foreground font-medium">它已有的译法</span>——从现有译文里数出来的，括号里是几条这么说、
                    共几条。数出来的不是猜的，但它也不是对齐：一句原文和它的译文对不出其中哪一个词变成了什么，
                    所以每一条都带例子让你一眼核，加入后是草稿，随时可改。
                  </CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setCandidates(null)}>收起</Button>
              </CardHeader>
              <CardContent className="p-0">
                {candidates.length === 0 ? (
                  <p className="text-muted-foreground p-6 text-sm">没有新的候选：反复出现的说法都已经在词库里了。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-40">候选词</TableHead>
                          <TableHead className="w-20">出现于</TableHead>
                          <TableHead>建议译法</TableHead>
                          {/* Pinned to the right edge. The example beside it can be a whole sentence,
                              and a table that scrolls sideways takes the button with it — leaving the
                              one thing the row exists for off-screen. */}
                          <TableHead className="bg-card sticky right-0 w-24 border-l" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {candidates.map((candidate) => (
                          // `data-candidate` is for the browser check: `加入` has to be found on *this*
                          // row, and the table has one button per candidate.
                          <TableRow key={candidate.term} data-candidate={candidate.term}>
                            <TableCell className="align-top font-medium">
                              {candidate.term}
                              {candidate.keepAsIs ? (
                                <Badge variant="outline" className="ml-1 text-[10px]">保持原样</Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-muted-foreground align-top text-sm tabular-nums">{candidate.keyCount} 条</TableCell>
                            <TableCell className="align-top">
                              {candidate.suggestions.length ? (
                                <span className="flex flex-col gap-1">
                                  {candidate.suggestions.map((suggestion) => (
                                    <span key={suggestion.locale} className="flex flex-col gap-0.5">
                                      <span className="flex flex-wrap items-baseline gap-1.5 text-sm">
                                        <span className="text-muted-foreground font-mono text-[11px]">{suggestion.locale}</span>
                                        <span className="font-medium">{suggestion.value}</span>
                                        {/* The count is the argument. `46/47` is a decision somebody can
                                            make in a glance; a bare value is a claim they have to check. */}
                                        <span className="text-muted-foreground text-[11px] tabular-nums">
                                          {suggestion.support}/{suggestion.total}
                                        </span>
                                      </span>
                                      {/* Truncated per half rather than as one line: the example is
                                          `what the source said → what the project wrote`, and cutting
                                          the end off would hide the translation — the half being judged. */}
                                      <span className="text-muted-foreground flex items-baseline gap-1 font-mono text-[11px]">
                                        <span className="max-w-[11rem] truncate" title={suggestion.example.source}>
                                          {suggestion.example.source}
                                        </span>
                                        <span aria-hidden>→</span>
                                        <span className="max-w-[13rem] truncate" title={suggestion.example.target}>
                                          {suggestion.example.target}
                                        </span>
                                      </span>
                                    </span>
                                  ))}
                                </span>
                              ) : (
                                <span className="text-muted-foreground text-sm">
                                  这个项目里还没有一致的译法——填上你确定的那一个
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="bg-card sticky right-0 border-l align-top">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy === candidate.term}
                                onClick={() =>
                                  void run(
                                    candidate.term,
                                    async () => {
                                      await post(`/projects/${projectId}/glossary`, {
                                        term: candidate.term,
                                        // The suggestion is a starting point, not an approval: it lands as
                                        // a draft like everything else, and the row above edits it.
                                        translations: Object.fromEntries(candidate.suggestions.map((item) => [item.locale, item.value])),
                                        ...(candidate.keepAsIs ? { doNotTranslate: true } : {}),
                                      });
                                      setCandidates((current) => current?.filter((entry) => entry.term !== candidate.term) ?? null);
                                    },
                                    candidate.suggestions.length
                                      ? `已加入 ${candidate.term}，译法取自现有译文，确认后定稿`
                                      : `已加入 ${candidate.term}，填上译法再定稿`,
                                  )
                                }
                              >
                                <Plus data-icon="inline-start" />
                                加入
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>手工加一条</CardTitle>
              <CardDescription>落成草稿。想让它成为规则，在列表里点「定稿」。</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!newTerm.trim() || !newLocale || !newValue.trim()) return;
                  const ok = await run(
                    'new',
                    () => post(`/projects/${projectId}/glossary`, { term: newTerm.trim(), translations: { [newLocale]: newValue.trim() } }),
                    `已加入 ${newTerm.trim()}`,
                  );
                  if (ok) {
                    setNewTerm('');
                    setNewValue('');
                  }
                }}
              >
                <label className="flex flex-col gap-1 text-xs">
                  原文词
                  <Input value={newTerm} onChange={(event) => setNewTerm(event.target.value)} placeholder="课程" className="w-48" />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  语言
                  <Select value={newLocale || undefined} onValueChange={setNewLocale}>
                    <SelectTrigger size="sm" className="w-44">
                      <SelectValue placeholder="选择语言" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {targetLocales.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code} · {localeDisplayName(code)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  译法
                  <Input value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="Course" className="w-56" />
                </label>
                <Button type="submit" disabled={busy === 'new' || !newTerm.trim() || !newLocale || !newValue.trim()}>
                  <Plus data-icon="inline-start" />
                  加入
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-0.5 pt-4">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </CardContent>
    </Card>
  );
}

/** State is the difference between a suggestion and a rule, so it gets a colour rather than a word. */
function StatusPill({ status }: { status: TermStatus }) {
  if (status === 'APPROVED') return <Badge variant="secondary" className="text-[10px]">已定稿</Badge>;
  if (status === 'DEPRECATED') return <Badge variant="outline" className="text-[10px]">已废弃</Badge>;
  return <Badge variant="muted" className="text-[10px]">草稿</Badge>;
}
