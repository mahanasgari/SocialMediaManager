'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'

type Row = {
  line: number
  content: string
  scheduledAt: string | null
  accountHandles: string[]
  accountIds: string[]
  problems: string[]
}

type Preview = {
  committed: boolean
  created?: number
  rows: Row[]
  ready: number
  broken: number
}

const SAMPLE = `content,scheduled,accounts
"Our roadmap for the quarter, in three bullets.",2026-10-01T09:00:00Z,@northwind
"Behind the scenes: how we test releases.",2026-10-03T15:30:00Z,"@northwind, @aurora-labs"
A draft with no date yet.,,@northwind`

/**
 * Bulk import.
 *
 * PREVIEW, THEN COMMIT — never one button that does both. Two hundred posts is
 * not something to discover you got wrong afterwards, and a published post has
 * no undo. So the first press only ever asks the server what WOULD happen, and
 * the second is offered only once every row is clean.
 *
 * A broken row is shown with its line number and what is wrong with it, rather
 * than being skipped. "Imported 18 of 20" leaves someone diffing a spreadsheet
 * against a calendar to find the two that vanished.
 */
export function ImportPosts({
  workspaceId,
  accounts,
}: {
  workspaceId: string
  accounts: Array<{ id: string; handle: string; displayName: string }>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [defaults, setDefaults] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<null | 'preview' | 'commit'>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(commit: boolean) {
    setBusy(commit ? 'commit' : 'preview')
    setError(null)

    const response = await fetch('/api/v1/posts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, csv, commit, defaultAccountIds: defaults }),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'That file could not be read.')
      setBusy(null)
      return
    }

    const result = (await response.json()) as Preview
    setBusy(null)

    if (result.committed) {
      setOpen(false)
      setPreview(null)
      setCsv('')
      router.refresh()
      return
    }
    setPreview(result)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload className="size-3.5" />
        Import CSV
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import posts from a spreadsheet</DialogTitle>
            <DialogDescription>
              One row per post. A <code>content</code> column is required; <code>scheduled</code>{' '}
              and <code>accounts</code> are optional — a row with no date becomes a draft.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="csv" className="text-sm font-medium">
                  Paste your CSV
                </label>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2"
                  onClick={() => setCsv(SAMPLE)}
                >
                  Use an example
                </button>
              </div>
              <Textarea
                id="csv"
                value={csv}
                onChange={(event) => {
                  setCsv(event.target.value)
                  // Any edit invalidates the preview. Leaving a stale one on
                  // screen next to changed text invites committing something
                  // nobody checked.
                  setPreview(null)
                }}
                rows={7}
                spellCheck={false}
                placeholder="content,scheduled,accounts"
                className="mt-1.5 font-mono text-xs"
              />
              <input
                type="file"
                accept=".csv,text/csv"
                className="mt-2 text-xs"
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  setCsv(await file.text())
                  setPreview(null)
                }}
              />
            </div>

            {accounts.length > 0 && (
              <div>
                <p className="text-xs font-medium">Channels for rows that name none</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {accounts.map((account) => {
                    const on = defaults.includes(account.id)
                    return (
                      <button
                        key={account.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setDefaults((prev) =>
                            on ? prev.filter((id) => id !== account.id) : [...prev, account.id]
                          )
                          setPreview(null)
                        }}
                        className={cn(
                          'rounded-md border px-2 py-1 text-xs transition-colors',
                          on
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-input text-muted-foreground hover:bg-accent'
                        )}
                      >
                        {account.handle}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {error && (
              <p className="flex gap-1.5 text-xs text-destructive" role="alert">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </p>
            )}

            {preview && (
              <div>
                <p className="text-sm">
                  {preview.broken === 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-success">
                      <CheckCircle2 className="size-4" />
                      {preview.ready} rows ready to import.
                    </span>
                  ) : (
                    <span className="text-destructive">
                      {preview.broken} of {preview.rows.length} rows have problems. Nothing will be
                      created until they are fixed.
                    </span>
                  )}
                </p>

                <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                  {preview.rows.map((row) => (
                    <div
                      key={row.line}
                      className={cn(
                        'rounded-md border p-2 text-xs',
                        row.problems.length > 0
                          ? 'border-destructive/40 bg-destructive/5'
                          : 'border-border'
                      )}
                    >
                      <div className="flex gap-2">
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          line {row.line}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{row.content || '(empty)'}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {row.scheduledAt
                            ? new Date(row.scheduledAt).toLocaleString(undefined, {
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : 'draft'}
                        </span>
                      </div>
                      {row.problems.map((problem) => (
                        <p key={problem} className="mt-1 text-destructive">
                          {problem}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={csv.trim().length === 0 || busy !== null}
              loading={busy === 'preview'}
              onClick={() => void send(false)}
            >
              Check the file
            </Button>
            {/* Offered only once the server has confirmed every row is clean.
                A commit button that might fail is a commit button that will. */}
            <Button
              disabled={!preview || preview.broken > 0 || busy !== null}
              loading={busy === 'commit'}
              onClick={() => void send(true)}
            >
              Import {preview && preview.broken === 0 ? `${preview.ready} posts` : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
