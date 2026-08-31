import { apiGet } from '@/lib/server-fetch'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader, formatBytes } from '@/components/ui'
import { RequestExport } from './exports.client'

type ExportJob = {
  id: string
  kind: 'WORKSPACE' | 'SUBJECT'
  subjectHandle: string | null
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED'
  bytes: number | null
  summary: Record<string, number> | null
  error: string | null
  createdAt: string
  finishedAt: string | null
  expiresAt: string | null
  requestedBy: { email: string } | null
}

const TONE = {
  PENDING: 'neutral',
  RUNNING: 'accent',
  READY: 'success',
  FAILED: 'danger',
  EXPIRED: 'warn',
} as const

/** What each status means, in words, because five states is more than an icon carries. */
const MEANING: Record<ExportJob['status'], string> = {
  PENDING: 'Queued. The worker picks it up on its next pass.',
  RUNNING: 'Being built now.',
  READY: 'Ready to download.',
  FAILED: 'Could not be built.',
  EXPIRED: 'The file was deleted after its download window. Request another.',
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export default async function ExportsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const jobs = await apiGet<ExportJob[]>(`/api/v1/exports?workspaceId=${workspaceId}`)

  if (!jobs.ok) return <ErrorCard message={jobs.message} requestId={jobs.requestId} />

  const inProgress = jobs.data.some((j) => j.status === 'PENDING' || j.status === 'RUNNING')

  return (
    <>
      <PageHeader
        title="Export"
        description="A copy of what this workspace holds — for portability, or to answer a request from someone whose data is in it."
      />

      <RequestExport workspaceId={workspaceId} busy={inProgress} />

      {jobs.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No exports yet"
            hint="A workspace export covers posts, media and metrics. A subject export covers everything held about one person, across every conversation in this workspace."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {jobs.data.map((job) => (
            <Card key={job.id} data-card="export" className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {job.kind === 'SUBJECT' ? (
                      <>
                        Everything about <span className="font-mono">{job.subjectHandle}</span>
                      </>
                    ) : (
                      'Whole workspace'
                    )}
                    <span className="ml-2">
                      <Badge tone={TONE[job.status]}>{job.status.toLowerCase()}</Badge>
                    </span>
                  </p>
                  <p className="mt-1 text-xs">
                    <Muted>
                      Requested {when(job.createdAt)}
                      {job.requestedBy ? ` by ${job.requestedBy.email}` : ''}
                    </Muted>
                  </p>
                  <p className="mt-1 text-xs">
                    <Muted>{MEANING[job.status]}</Muted>
                  </p>

                  {/* Row counts, so an empty export is distinguishable from a
                      broken one — the single most common question about any
                      export, and one a byte count alone cannot answer. */}
                  {job.summary && (
                    <p className="mt-1.5 text-xs">
                      <Muted>
                        {Object.entries(job.summary)
                          .map(([k, v]) => `${v} ${k}`)
                          .join(' · ')}
                        {job.bytes ? ` · ${formatBytes(job.bytes)}` : ''}
                      </Muted>
                    </p>
                  )}

                  {job.error && <p className="mt-1.5 text-xs text-destructive">{job.error}</p>}

                  {job.status === 'READY' && job.expiresAt && (
                    <p className="mt-1.5 text-xs text-warning">
                      Deleted after {when(job.expiresAt)}
                    </p>
                  )}
                </div>

                {job.status === 'READY' && (
                  // A plain link, not a fetch-and-blob. The response carries
                  // Content-Disposition, so the browser saves it with the right
                  // name and the download survives a page navigation.
                  <a
                    href={`/api/v1/exports/${job.id}/download?workspaceId=${workspaceId}`}
                    className="inline-flex h-8 shrink-0 items-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    Download
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
