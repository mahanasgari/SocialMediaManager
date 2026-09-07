'use client'

import { useState } from 'react'
import type { ProviderDescriptor } from '@/lib/api'
import { Badge, Card, Muted } from '@/components/ui'
import { cn } from '@/lib/cn'
import { ConnectButton } from './actions.client'
import { ConnectForm } from './connect-form.client'

/**
 * One network, and the routes that reach it.
 *
 * Instagram can now be reached three ways and Facebook two. They are separate
 * providers underneath — separate capabilities, separate credentials, separate
 * adapters — and that is correct, because the capability matrix has to state
 * what each one can actually do. But to a person connecting an account they are
 * one network and a decision about how to get to it, and three sibling cards
 * with near-identical names invite picking the wrong one for reasons nobody
 * explained.
 *
 * So the grouping is presentation only. Nothing downstream learns about it: the
 * connect call still names one provider id, and the publisher, composer and
 * inbox continue to see distinct providers.
 *
 * What the chooser must do to be worth having is show the COST of each route
 * next to the choice. A route that cannot read comments or delete a post is not
 * a lesser version of the same thing — it is a different trade, and the moment
 * to learn that is before connecting, not the first time the inbox is empty.
 */
export function ProviderGroup({
  workspaceId,
  routes,
  canConnect,
}: {
  workspaceId: string
  routes: ProviderDescriptor[]
  canConnect: boolean
}) {
  // Default to the PRIMARY route — the direct one, first in registration order —
  // even when it is unavailable and another route works.
  //
  // Defaulting to whatever happened to be usable was the first version of this
  // and it was wrong twice over. It silently steered anyone connecting Instagram
  // or Facebook through a third party's servers, which is a decision about where
  // your data goes and belongs to the person, not the default. And it HID the
  // reason the direct route was unavailable: "your administrator has not
  // configured this" is the one sentence that tells someone what to do, and
  // landing on a working alternative meant they never saw it.
  //
  // Landing on a disabled route is only a dead end if the alternatives are
  // invisible, and they are not — they are the row of buttons directly below,
  // with a line naming the one that works.
  const [selectedId, setSelectedId] = useState(routes[0]!.id)
  const selected = routes.find((r) => r.id === selectedId) ?? routes[0]!
  const alternative =
    selected.disabledReason && routes.find((r) => r.id !== selected.id && !r.disabledReason)

  const single = routes.length === 1
  const networkLabel = routes.find((r) => r.id === r.network)?.label ?? routes[0]!.label

  return (
    <Card
      data-testid={single ? `provider-${selected.id}` : `network-${selected.network}`}
      className="p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{single ? selected.label : networkLabel}</p>
            {selected.state === 'mock' && <Badge>simulator</Badge>}
            {selected.state === 'skeleton' && <Badge>not built yet</Badge>}
          </div>
          <p className="mt-0.5 text-xs">
            <Muted>{selected.disabledReason ?? capabilitySummary(selected.capabilities)}</Muted>
          </p>
        </div>

        {/* Which control appears comes from the SELECTED route's own
            declaration, so a route needing a pasted key and one needing a
            redirect can sit side by side under one network. */}
        {selected.connectFields.length > 0 ? (
          <ConnectForm
            key={selected.id}
            workspaceId={workspaceId}
            provider={selected.id}
            label={selected.label}
            fields={[...selected.connectFields]}
            authStyle={selected.authStyle}
            disabled={!canConnect || Boolean(selected.disabledReason)}
          />
        ) : (
          <ConnectButton
            key={selected.id}
            workspaceId={workspaceId}
            provider={selected.id}
            disabled={!canConnect || Boolean(selected.disabledReason)}
          />
        )}
      </div>

      {!single && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium">How to connect</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Connection route">
            {routes.map((route) => (
              <button
                key={route.id}
                type="button"
                role="radio"
                aria-checked={route.id === selected.id}
                data-testid={`provider-${route.id}`}
                onClick={() => setSelectedId(route.id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition-colors',
                  route.id === selected.id
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:text-foreground',
                  // A route that cannot be used is still shown and still
                  // selectable, because its reason is the useful part: "needs
                  // an app your administrator has not configured" is what tells
                  // someone to pick the other one.
                  route.disabledReason && 'opacity-70'
                )}
              >
                {routeName(route)}
                {route.disabledReason && ' ·  unavailable'}
              </button>
            ))}
          </div>

          <p className="mt-2 text-xs">
            <Muted>{routeSummary(selected)}</Muted>
          </p>

          {/* The route you are looking at cannot be used, but one here can.
              Without this line a disabled default reads as "this network is
              unavailable" while a working route sits one click away. */}
          {alternative && (
            <p className="mt-1 text-xs text-warning">
              {routeName(alternative)} works on this install and needs no administrator setup.
            </p>
          )}
        </div>
      )}

      {/* A caveat on a route that WORKS, in warning colour and before anyone
          connects — the failure it describes is invisible afterwards. */}
      {selected.notice && (
        <p className="mt-2 max-w-prose text-xs text-warning">{selected.notice}</p>
      )}
    </Card>
  )
}

/**
 * The route's name with the network stripped off.
 *
 * "Instagram (via Buffer)" under a heading that already says Instagram reads as
 * a stutter; "via Buffer" reads as a choice.
 */
function routeName(route: ProviderDescriptor): string {
  const match = /\(via ([^)]+)\)/.exec(route.label)
  if (match) return `via ${match[1]}`
  if (route.id === route.network) return 'Direct'
  // A second first-party route: "Instagram Login" against "Instagram".
  return route.label.replace(/^\w+\s/, '') || route.label
}

/**
 * What choosing this route costs, in the terms someone actually cares about.
 *
 * Built from the capability matrix rather than written per route, so a route
 * whose capabilities change cannot keep an out-of-date description — the same
 * reason the summary line is derived rather than authored.
 */
function routeSummary(route: ProviderDescriptor): string {
  const gains: string[] = []
  const losses: string[] = []

  const say = (key: string, label: string) => {
    if (route.capabilities[key]) gains.push(label)
    else losses.push(label)
  }

  say('comments', 'comments')
  say('dm', 'DMs')
  say('deletePost', 'delete')
  say('analytics', 'analytics')

  const parts: string[] = []
  if (gains.length > 0) parts.push(`Includes ${gains.join(', ')}`)
  if (losses.length > 0) parts.push(`no ${losses.join(', ')}`)
  return parts.join(' · ')
}

/**
 * Built from the capability matrix the API serves, never a hard-coded list.
 * That is what keeps "never claim unsupported functionality" structural rather
 * than a discipline someone has to remember when adding a provider.
 */
export function capabilitySummary(capabilities: Record<string, boolean>): string {
  const supported = [
    capabilities['textPost'] && 'text',
    capabilities['imagePost'] && 'images',
    capabilities['videoPost'] && 'video',
    capabilities['thread'] && 'threads',
    capabilities['dm'] && 'DMs',
    capabilities['analytics'] && 'analytics',
  ].filter(Boolean)
  return supported.length > 0 ? `Supports ${supported.join(', ')}` : 'No publishing capabilities'
}
