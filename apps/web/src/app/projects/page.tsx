'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Boxes, GitBranch, Languages, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, formatDateTime, useAsync } from '@/components/use-async';
import { del, get, post, type ProjectSummary } from '@/lib/api';
import { canDeleteProject } from '@/lib/project-access';
import { LocalePicker } from '@/components/locale-picker';
import { LocaleChips } from '@/components/locale-chips';
import { PlatformPicker } from '@/components/platform-picker';

const EMPTY_FORM = {
  name: '',
  slug: '',
  // Empty rather than a guess: the source language is the one decision that cannot be taken back
  // once translations exist, so it is chosen deliberately instead of being pre-filled with
  // whatever the last project used.
  sourceLocale: '',
  locales: [] as string[],
  platforms: ['web'] as string[],
};

export default function ProjectsPage() {
  const { data, error, loading, reload } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Deleting from the list. `target` is the whole row rather than an id: the dialog has to name the
  // project it is about to destroy, and after the delete the row is gone from `data`.
  const [target, setTarget] = useState<ProjectSummary | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await post('/projects', {
        name: form.name,
        ...(form.slug ? { slug: form.slug } : {}),
        sourceLocale: form.sourceLocale,
        locales: form.locales,
        platforms: form.platforms,
      });
      toast.success(`项目「${form.name}」已创建`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Delete the project behind the open dialog, and reload the list in place.
   *
   * The name is required by the API, not only by this dialog: the project's keys, translations,
   * sketches and sync history go with it and there is no undo. The repository's language files are
   * untouched — this deletes the platform's copy.
   */
  async function remove() {
    if (!target) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await del(`/projects/${target.id}?confirmName=${encodeURIComponent(deleteConfirm)}`);
      toast.success(`项目「${target.name}」已删除`);
      setTarget(null);
      await reload();
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="项目管理"
        description="每个项目对应一个产品，可绑定多个代码仓库连接"
        actions={
          <Button onClick={() => setShowForm((open) => !open)}>
            <Plus />
            新建项目
          </Button>
        }
      />

      <ErrorAlert error={error} />

      {showForm ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">新建项目</CardTitle>
            <CardDescription>源语言是原文语言；目标语言可稍后在「语言配置」中调整</CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorAlert error={formError} onDismiss={() => setFormError(null)} />
            <form onSubmit={create}>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="name">项目名称</FieldLabel>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Demo App"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="slug">Slug（可选）</FieldLabel>
                  <Input
                    id="slug"
                    value={form.slug}
                    onChange={(event) => setForm({ ...form, slug: event.target.value })}
                    placeholder="demo-app"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sourceLocale">源语言</FieldLabel>
                  <LocalePicker
                    id="sourceLocale"
                    value={form.sourceLocale}
                    onChange={(sourceLocale) =>
                      setForm({
                        ...form,
                        sourceLocale,
                        // The source is not also a target; the platform stores it as a locale too,
                        // but listing it twice in the form reads like a mistake.
                        locales: form.locales.filter((code) => code !== sourceLocale),
                      })
                    }
                    placeholder="选择原文语言"
                  />
                  <FieldDescription>
                    原文语言。创建后一旦有译文就无法再改，所以先确认仓库里的源语言目录叫什么。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="locales">目标语言</FieldLabel>
                  <LocalePicker
                    id="locales"
                    multiple
                    value={form.locales}
                    onChange={(locales) => setForm({ ...form, locales })}
                    exclude={form.sourceLocale ? [form.sourceLocale] : []}
                    placeholder="添加目标语言"
                  />
                  <FieldDescription>可以稍后在项目设置里增删。</FieldDescription>
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel>平台</FieldLabel>
                  <PlatformPicker value={form.platforms} onChange={(platforms) => setForm({ ...form, platforms })} />
                  <FieldDescription>
                    决定 Key 的身份。要与仓库里语言文件映射的 platform 一致，之后改动需要重导。
                  </FieldDescription>
                </Field>
                {form.locales.length ? (
                  <Field className="sm:col-span-2">
                    <FieldLabel>将创建的语言</FieldLabel>
                    <LocaleChips
                      codes={[form.sourceLocale, ...form.locales].filter(Boolean)}
                      source={form.sourceLocale}
                      onRemove={(code) => setForm({ ...form, locales: form.locales.filter((item) => item !== code) })}
                    />
                  </Field>
                ) : null}
                <Field orientation="horizontal" className="sm:col-span-2">
                  <Button type="submit" disabled={busy || !form.name || !form.sourceLocale}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    创建
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                    取消
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">全部项目</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>源语言</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">Key</TableHead>
                  <TableHead className="text-right">条目</TableHead>
                  <TableHead className="text-right">revision</TableHead>
                  <TableHead>我的角色</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                      <div className="text-muted-foreground font-mono text-xs">{project.slug}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{project.sourceLocale}</TableCell>
                    <TableCell className="text-muted-foreground text-xs" title={formatDateTime(project.createdAt)}>
                      {timeAgo(project.createdAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.keys}</TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.entries}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{project.revision}</TableCell>
                    <TableCell>
                      <StatusBadge status={project.role ?? 'READONLY'} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/translations`}>
                            <Languages data-icon="inline-start" />
                            翻译
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/sync`}>
                            <GitBranch data-icon="inline-start" />
                            同步
                          </Link>
                        </Button>
                        {/* Only for roles the API will accept — the same rule the project's own
                            settings page uses, from one definition. A DEVELOPER who sees this button
                            would be looking at a control whose only outcome is a 403. */}
                        {canDeleteProject(project.role) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            data-delete={project.id}
                            onClick={() => {
                              setTarget(project);
                              setDeleteConfirm('');
                              setDeleteError(null);
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            删除
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={<Boxes />} title="还没有项目" description="点击右上角「新建项目」创建第一个项目。" />
          )}
        </CardContent>
      </Card>

      {/* Deleting from the list, with the same guard the project's own page uses: the name typed
          back exactly. The API enforces it too — this dialog is the explanation, not the security
          boundary. */}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{target?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              这个操作无法撤销：项目里的 Key、译文、UI 页面和同步历史会一起消失。仓库里的语言文件不动。
              请输入项目名以确认。
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Field>
            <FieldLabel htmlFor="delete-project-confirm">项目名</FieldLabel>
            <Input
              id="delete-project-confirm"
              value={deleteConfirm}
              autoComplete="off"
              placeholder={target?.name ?? ''}
              onChange={(event) => setDeleteConfirm(event.target.value)}
            />
            <FieldDescription>必须与项目名完全一致，删除按钮才会可用。</FieldDescription>
          </Field>

          <ErrorAlert error={deleteError} />

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            {/* A plain Button rather than AlertDialogAction: that one closes the dialog on click, so
                a refused delete would take its error message with it. */}
            <Button
              variant="destructive"
              data-delete-confirm
              disabled={deleting || deleteConfirm !== (target?.name ?? '')}
              onClick={() => void remove()}
            >
              {deleting ? <Spinner /> : <Trash2 />}
              永久删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
