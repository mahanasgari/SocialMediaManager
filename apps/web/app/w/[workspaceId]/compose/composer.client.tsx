'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Image as ImageIcon,
  Paperclip,
  RotateCcw,
} from 'lucide-react'
import type { MediaRow, SocialAccount } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/toggles'

type Issue = { code: string; severity: 'error' | 'warning'; message: string }
type Validation = {
  accountId: string
  handle: string
  provider?: string
  surface?: string
  limit: number | null
  length?: number
  linkHandling?: 'kept' | 'stripped' | 'shortened' | null
  maxMedia?: number | null
  issues: Issue[]
}

type PostOptionField = {
  name: string
  label: string
  hint?: string
  placeholder?: string
  required?: boolean
  options?: { value: string; label: string }[]
}

/** The shared draft, or one channel's rewrite of it. */
const SHARED = '__shared__'

/**
 * The composer.
 *
 * Two rules shape it.
 *
 * VALIDATION IS THE API'S ANSWER, never this file's. The endpoint calls the
 * same pure validate() the worker calls before publishing, so a rule can only
 * be in one place. Reimplementing limits here would create a second source of
 * truth, and the symptom would be a post the composer accepted and the worker
 * refused, hours later, at 09:00.
 *
 * ONE TEXT RARELY SUITS EVERY NETWORK. 280 characters on X and 2,200 on
 * Instagram are not the same piece of writing, and Instagram strips links that
 * LinkedIn keeps. So a post carries a shared draft plus optional per-channel
 * rewrites, and the preview shows what each network will actually receive —
 * including the part that will not fit.
 */
export function Composer({
  workspaceId,
  accounts,
  media,
  optionFields,
}: {
  workspaceId: string
  accounts: SocialAccount[]
  media: MediaRow[]
  /** Per-post fields each provider needs, keyed by provider id. */
  optionFields: Record<string, PostOptionField[]>
}) {
  const router = useRouter()
  const [content, setContent] = useState('')
  const [selected, setSelected] = useState<string[]>(accounts[0] ? [accounts[0].id] : [])
  const [scheduledAt, setScheduledAt] = useState('')
  const [attached, setAttached] = useState<string[]>([])
  /** Per-channel rewrites, keyed by account id. Absent means "use the shared draft". */
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  /** Which tab is being edited: the shared draft, or one channel. */
  const [tab, setTab] = useState<string>(SHARED)
  const [options, setOptions] = useState<Record<string, Record<string, string>>>({})
  const [validation, setValidation] = useState<Validation[]>([])
  const [busy, setBusy] = useState<null | 'draft' | 'schedule' | 'now'>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  /** What a given channel will actually publish. */
  const textFor = (accountId: string) => overrides[accountId] ?? content

  // A tab for a channel that has just been deselected would edit text nobody
  // will publish, so editing falls back to the shared draft.
  useEffect(() => {
    if (tab !== SHARED && !selected.includes(tab)) setTab(SHARED)
  }, [selected, tab])

  // Debounced so a keystroke does not become a request. 250ms is short enough
  // to feel live and long enough that typing a sentence is one call, not thirty.
  useEffect(() => {
    if (selected.length === 0) {
      setValidation([])
      return
    }
    const timer = setTimeout(async () => {
      const response = await fetch('/api/v1/posts/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
        body: JSON.stringify({
          workspaceId,
          content,
          accountIds: selected,
          // Each channel is checked against ITS text, not the shared draft — a
          // rewrite that fixes an overflow must clear the error it fixed.
          contentOverrides: overrides,
        }),
      })
      if (response.ok) setValidation((await response.json()) as Validation[])
    }, 250)
    return () => clearTimeout(timer)
  }, [content, overrides, selected, workspaceId])

  const blocking = useMemo(
    () => validation.some((v) => v.issues.some((i) => i.severity === 'error')),
    [validation]
  )

  // A required provider setting that is empty blocks submission HERE rather
  // than failing in the worker. Telegram refuses to publish without a chat, and
  // discovering that at 09:00 from a FAILED variant is the worst place to find
  // out — the composer already knows.
  const missingOption = selected.some((id) => {
    const account = accounts.find((a) => a.id === id)
    if (!account) return false
    return (optionFields[account.provider] ?? []).some(
      (field) => field.required === true && (options[id]?.[field.name] ?? '').trim().length === 0
    )
  })

  const canSubmit =
    content.trim().length > 0 && selected.length > 0 && !blocking && !missingOption && busy === null

  const activeText = tab === SHARED ? content : textFor(tab)
  const activeCheck = tab === SHARED ? null : validation.find((v) => v.accountId === tab)

  /**
   * The limit shown next to the editor.
   *
   * On a channel tab it is that channel's. On the shared tab it is the
   * TIGHTEST across selected channels — the one that binds, and the only
   * honest number when one piece of text is going everywhere.
   */
  const activeLimit = useMemo(() => {
    if (tab !== SHARED) return activeCheck?.limit ?? null
    const limits = validation
      .filter((v) => overrides[v.accountId] === undefined)
      .map((v) => v.limit)
      .filter((l): l is number => typeof l === 'number')
    return limits.length > 0 ? Math.min(...limits) : null
  }, [tab, activeCheck, validation, overrides])

  function setActiveText(value: string) {
    if (tab === SHARED) setContent(value)
    else setOverrides((prev) => ({ ...prev, [tab]: value }))
  }

  async function submit(mode: 'draft' | 'schedule' | 'now') {
    setBusy(mode)
    setError(null)
    setResult(null)

    const create = await fetch('/api/v1/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({
        workspaceId,
        content,
        accountIds: selected,
        contentOverrides: overrides,
        platformOptions: options,
        mediaIds: attached,
        ...(mode === 'schedule' && scheduledAt
          ? { scheduledAt: new Date(scheduledAt).toISOString() }
          : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    })

    if (!create.ok) {
      const body = (await create.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'Could not save the post.')
      setBusy(null)
      return
    }

    const post = (await create.json()) as { id: string }

    if (mode !== 'now') {
      router.push(`/w/${workspaceId}/posts`)
      router.refresh()
      return
    }

    const published = await fetch(`/api/v1/posts/${post.id}/publish?workspaceId=${workspaceId}`, {
      method: 'POST',
      headers: { 'x-smm-client': 'web' },
    })

    if (!published.ok) {
      const body = (await published.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'The post was saved but could not be published.')
      setBusy(null)
      return
    }

    // Shows the per-channel outcome, because partial success is the normal case
    // and "posted!" would be a lie whenever one channel rejected the content.
    const outcome = (await published.json()) as { summary: string }
    setResult(outcome.summary)
    setBusy(null)
    router.refresh()
  }

  const selectedAccounts = accounts.filter((a) => selected.includes(a.id))

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_19rem]">
      <div className="space-y-4">
        <Card>
          <CardContent className="p-4">
            {/* One tab per selected channel, so a rewrite is one click away
                rather than a separate screen. A dot marks a channel whose text
                has diverged — without it, a rewrite made yesterday is
                invisible today. */}
            <div className="-mx-1 mb-3 flex flex-wrap gap-1 overflow-x-auto">
              <TabButton active={tab === SHARED} onClick={() => setTab(SHARED)}>
                All channels
              </TabButton>
              {selectedAccounts.map((a) => (
                <TabButton key={a.id} active={tab === a.id} onClick={() => setTab(a.id)}>
                  <span className="truncate">{a.handle}</span>
                  {overrides[a.id] !== undefined && (
                    <span
                      className="ml-1 inline-block size-1.5 rounded-full bg-primary"
                      aria-label="customised"
                    />
                  )}
                </TabButton>
              ))}
            </div>

            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="content">
                {tab === SHARED
                  ? 'Shared text'
                  : `Text for ${activeCheck?.handle ?? 'this channel'}`}
              </Label>
              <div className="flex items-center gap-2">
                {tab !== SHARED && overrides[tab] !== undefined && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setOverrides((prev) => {
                        const next = { ...prev }
                        delete next[tab]
                        return next
                      })
                    }
                  >
                    <RotateCcw className="size-3" />
                    Use shared text
                  </button>
                )}
                {activeLimit !== null && (
                  <span
                    className={cn(
                      'tabular text-xs',
                      activeText.length > activeLimit
                        ? 'font-medium text-destructive'
                        : 'text-muted-foreground'
                    )}
                  >
                    {activeText.length} / {activeLimit}
                  </span>
                )}
              </div>
            </div>

            <Textarea
              id="content"
              value={activeText}
              onChange={(e) => setActiveText(e.target.value)}
              rows={9}
              placeholder={
                tab === SHARED ? 'What are you posting?' : 'Rewrite this post for this channel…'
              }
              className="mt-1.5 resize-y"
            />

            {tab === SHARED && selectedAccounts.length > 1 && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Goes to every selected channel. Open a channel above to write something different
                for it.
              </p>
            )}

            <div className="mt-4">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Paperclip className="size-3.5" />
                Attach media
              </p>

              {/* Shown even when the library is EMPTY, and that is the point.
                  Instagram and YouTube both refuse a post with no media, so a
                  composer that hides the whole section when there is nothing to
                  attach leaves someone reading "must include at least one
                  image" with nothing on screen to act on. */}
              {media.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Nothing in this workspace&apos;s library yet.{' '}
                  <Link
                    href={`/w/${workspaceId}/media`}
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    Upload an image or video
                  </Link>{' '}
                  — Instagram and YouTube require one.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {media.slice(0, 12).map((m) => {
                    const on = attached.includes(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setAttached((prev) =>
                            on ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                          )
                        }
                        className={cn(
                          'inline-flex max-w-[11rem] items-center gap-1 truncate rounded-md border px-2 py-1 text-xs',
                          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          on
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-input text-muted-foreground hover:bg-accent'
                        )}
                      >
                        {on && <Check className="size-3 shrink-0" />}
                        <span className="truncate">{m.filename}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="schedule">Schedule for</Label>
              <Input
                id="schedule"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-auto"
              />
            </div>

            <Button
              disabled={!canSubmit || !scheduledAt}
              loading={busy === 'schedule'}
              onClick={() => submit('schedule')}
            >
              Schedule
            </Button>
            <Button
              variant="outline"
              disabled={!canSubmit}
              loading={busy === 'now'}
              onClick={() => submit('now')}
            >
              Publish now
            </Button>
            <Button
              variant="ghost"
              disabled={!canSubmit}
              loading={busy === 'draft'}
              onClick={() => submit('draft')}
            >
              Save draft
            </Button>
          </CardContent>
        </Card>

        {error && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="flex gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{result}</span>
          </div>
        )}

        {/* The preview.
            Deliberately NOT an imitation of any network's interface — it is
            this product's own rendering of what each one will receive. Copying
            their chrome would be both a legal problem and a worse tool, because
            what matters here is the part a mock-up hides: exactly where the
            text stops fitting, and what the network will do to the links. */}
        {selectedAccounts.length > 0 && content.trim().length > 0 && (
          <div>
            <p className="text-xs font-medium">What each channel receives</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {selectedAccounts.map((a) => (
                <PreviewCard
                  key={a.id}
                  account={a}
                  text={textFor(a.id)}
                  customised={overrides[a.id] !== undefined}
                  check={validation.find((v) => v.accountId === a.id)}
                  mediaCount={attached.length}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <aside>
        <p className="text-xs font-medium">Channels</p>

        {accounts.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No active accounts. Connect one first.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {accounts.map((a) => {
              const check = validation.find((v) => v.accountId === a.id)
              const errorsFor = check?.issues.filter((i) => i.severity === 'error') ?? []
              const warningsFor = check?.issues.filter((i) => i.severity === 'warning') ?? []
              const isSelected = selected.includes(a.id)
              const length = textFor(a.id).length

              return (
                <div
                  key={a.id}
                  className={cn(
                    'rounded-lg border p-2.5 transition-colors',
                    errorsFor.length > 0
                      ? 'border-destructive/50 bg-destructive/5'
                      : isSelected
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border'
                  )}
                >
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(next) =>
                        setSelected((prev) =>
                          next === true ? [...prev, a.id] : prev.filter((id) => id !== a.id)
                        )
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.handle}
                        {/* The per-channel count, because a post can fit one
                            network and overflow another — the whole reason
                            variants exist. */}
                        {isSelected && check?.limit ? (
                          <span
                            className={cn(
                              'tabular ml-1',
                              length > check.limit && 'font-medium text-destructive'
                            )}
                          >
                            · {length}/{check.limit}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </label>

                  {errorsFor.map((i) => (
                    <p key={i.code} className="mt-1.5 flex gap-1.5 text-xs text-destructive">
                      <AlertCircle className="mt-0.5 size-3 shrink-0" />
                      {i.message}
                    </p>
                  ))}
                  {warningsFor.map((i) => (
                    <p key={i.code} className="mt-1.5 flex gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {i.message}
                    </p>
                  ))}

                  {/* Per-post provider settings, shown only for the account
                      they belong to and only when it is actually selected.
                      Telegram is the case that forced this: a bot is a sender,
                      not an audience, so the channel is chosen when writing
                      rather than when connecting. */}
                  {isSelected &&
                    (optionFields[a.provider] ?? []).map((field) => {
                      const value = options[a.id]?.[field.name] ?? ''
                      const missing = field.required === true && value.trim().length === 0
                      return (
                        <div key={field.name} className="mt-2 pl-7">
                          <label htmlFor={`${a.id}-${field.name}`} className="text-xs font-medium">
                            {field.label}
                            {field.required && <span className="text-destructive"> *</span>}
                          </label>
                          {field.options ? (
                            <select
                              id={`${a.id}-${field.name}`}
                              value={value}
                              aria-invalid={missing}
                              className={cn(
                                'mt-1 h-8 w-full rounded-md border border-input bg-transparent',
                                'px-2 text-sm shadow-sm transition-colors focus-visible:outline-none',
                                'focus-visible:ring-2 focus-visible:ring-ring',
                                missing && 'border-destructive'
                              )}
                              onChange={(event) =>
                                setOptions((prev) => ({
                                  ...prev,
                                  [a.id]: { ...prev[a.id], [field.name]: event.target.value },
                                }))
                              }
                            >
                              {/* No preselected choice. A default here would be
                                  the product answering a question meant for the
                                  person — which on YouTube means uploading
                                  something nobody can see. */}
                              <option value="">Choose…</option>
                              {field.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Input
                              id={`${a.id}-${field.name}`}
                              value={value}
                              placeholder={field.placeholder ?? ''}
                              autoComplete="off"
                              spellCheck={false}
                              className="mt-1 h-8 text-sm"
                              aria-invalid={missing}
                              onChange={(event) =>
                                setOptions((prev) => ({
                                  ...prev,
                                  [a.id]: { ...prev[a.id], [field.name]: event.target.value },
                                }))
                              }
                            />
                          )}
                          {field.hint && (
                            <p className="mt-1 text-xs text-muted-foreground">{field.hint}</p>
                          )}
                        </div>
                      )
                    })}
                </div>
              )
            })}
          </div>
        )}
      </aside>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex max-w-[12rem] items-center rounded-md px-2.5 py-1 text-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

/**
 * One channel's rendering of the post.
 *
 * The overflow is the reason this exists. A counter reading 320/280 tells
 * someone they are over; showing the exact words that will be cut tells them
 * which sentence to lose.
 */
function PreviewCard({
  account,
  text,
  customised,
  check,
  mediaCount,
}: {
  account: SocialAccount
  text: string
  customised: boolean
  check: Validation | undefined
  mediaCount: number
}) {
  const limit = check?.limit ?? null
  const over = limit !== null && text.length > limit
  const kept = over ? text.slice(0, limit!) : text
  const cut = over ? text.slice(limit!) : ''

  const hasLink = /https?:\/\/\S+/i.test(text)
  const strips = check?.linkHandling === 'stripped'
  const tooMuchMedia = typeof check?.maxMedia === 'number' && mediaCount > check.maxMedia

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
          aria-hidden
        >
          {account.displayName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{account.displayName}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {check?.provider ?? account.provider}
            {check?.surface ? ` · ${check.surface}` : ''}
          </p>
        </div>
        {customised && (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            custom
          </span>
        )}
      </div>

      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed">
        {kept}
        {cut && (
          <span
            className="bg-destructive/10 text-destructive line-through"
            title="Beyond this channel's limit"
          >
            {cut}
          </span>
        )}
      </p>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {mediaCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <ImageIcon className="size-3" />
            {mediaCount} attached
          </span>
        )}
        {tooMuchMedia && (
          <span className="text-destructive">only {check?.maxMedia} will be used</span>
        )}
        {hasLink && strips && <span className="text-warning">links are not clickable here</span>}
      </div>
    </div>
  )
}
