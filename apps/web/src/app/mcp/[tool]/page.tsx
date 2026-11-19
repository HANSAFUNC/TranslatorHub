'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Plug } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock } from '@/components/code-block';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { useAsync } from '@/components/use-async';
import { get } from '@/lib/api';
import type { McpToolProperty, McpTools } from '@/lib/mcp-tools';

/**
 * One tool, on its own page.
 *
 * The list answers "what can an agent do here"; it cannot answer "so what do I send it", which is the
 * next question and the one that costs a round trip when it is wrong. A tool's parameters are the
 * contract — the names, which are required, what each one means — and reading them off a schema was
 * something only the MCP client could do until now.
 */
export default function McpToolPage() {
  const params = useParams<{ tool: string }>();
  const name = decodeURIComponent(params.tool);
  const { data, error, loading } = useAsync(() => get<McpTools>('/mcp/tools'), []);
  const tool = data?.remote.find((entry) => entry.name === name);

  if (loading) {
    return (
      <>
        <PageHeader title={name} />
        <Skeleton className="h-64" />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title={name} />
        <ErrorAlert error={error} />
      </>
    );
  }

  if (!tool) {
    return (
      <>
        <PageHeader title="没有这个工具" />
        <EmptyState
          icon={<Plug />}
          title={`平台没有注册名为 ${name} 的工具`}
          description="它可能已经改名或被移除。回 MCP 管理看当前的清单。"
        />
      </>
    );
  }

  const properties = Object.entries(tool.inputSchema?.properties ?? {});
  const required = new Set(tool.inputSchema?.required ?? []);

  return (
    <>
      <PageHeader
        title={<span className="font-mono text-lg">{tool.name}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="muted" className="text-[10px]">
              {tool.server === 'remote' ? 'Remote MCP' : tool.server}
            </Badge>
            <span>
              {properties.length} 个参数
              {required.size ? ` · ${required.size} 个必填` : ' · 没有必填参数'}
            </span>
          </span>
        }
        actions={
          <Link href="/mcp" className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
            <ArrowLeft className="size-4" />
            回 MCP 管理
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>这个工具是做什么的</CardTitle>
          </CardHeader>
          <CardContent>
            {/* The whole description, not the one-line version the list has room for: for several tools
                it is where the rules live (what a screen is, which input is preferred, what a finding
                means), and truncating it would hide exactly the part a caller needs. */}
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{tool.description}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>参数</CardTitle>
            <CardDescription>
              MCP 客户端按这份 schema 校验；这里的名字就是调用时要传的字段名。
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {properties.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-56">字段</TableHead>
                    <TableHead className="w-24">类型</TableHead>
                    <TableHead className="w-20">必填</TableHead>
                    <TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {properties.map(([field, schema]) => (
                    <TableRow key={field}>
                      <TableCell className="align-top font-mono text-xs">{field}</TableCell>
                      <TableCell className="text-muted-foreground align-top font-mono text-xs">
                        {describeType(schema)}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {required.has(field) ? (
                          <Badge variant="warning" className="text-[10px]">
                            必填
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">可选</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        {schema.description ? (
                          <span className="leading-relaxed whitespace-pre-wrap">{schema.description}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {/* Nested shapes (a frame's `ui`, a marker) are where a caller gets lost, so
                            they get their own listing rather than a `[object]` in the type column. */}
                        {schema.properties ? (
                          <div className="text-muted-foreground mt-1 font-mono text-xs">
                            {Object.entries(schema.properties)
                              .map(([inner, innerSchema]) => `${inner}: ${describeType(innerSchema)}${schema.required?.includes(inner) ? ' *' : ''}`)
                              .join(' · ')}
                          </div>
                        ) : null}
                        {schema.items?.properties ? (
                          <div className="text-muted-foreground mt-1 font-mono text-xs">
                            每项：
                            {Object.entries(schema.items.properties)
                              .map(([inner, innerSchema]) => `${inner}: ${describeType(innerSchema)}${schema.items?.required?.includes(inner) ? ' *' : ''}`)
                              .join(' · ')}
                          </div>
                        ) : null}
                        {schema.default !== undefined ? (
                          <div className="text-muted-foreground mt-1 text-xs">默认 {JSON.stringify(schema.default)}</div>
                        ) : null}
                        {schema.enum ? (
                          <div className="text-muted-foreground mt-1 font-mono text-xs">
                            取值：{schema.enum.map((value) => JSON.stringify(value)).join(' / ')}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">这个工具没有参数。</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>原始 schema</CardTitle>
            <CardDescription>
              客户端握手时拿到的就是这一份。要照着写调用，可以直接复制。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock what="参数 schema" code={JSON.stringify(tool.inputSchema ?? {}, null, 2)} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** The type as a caller would write it, with nested shapes named rather than printed as `object`. */
function describeType(schema: McpToolProperty): string {
  if (schema.type === 'array') return `${schema.items ? describeType(schema.items) : 'any'}[]`;
  if (schema.type === 'object') return 'object';
  if (!schema.type) return 'any';
  return schema.type;
}
