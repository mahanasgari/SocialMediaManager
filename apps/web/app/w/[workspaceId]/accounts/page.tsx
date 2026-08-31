import { getAccounts, getProviders, getWorkspace } from '@/lib/api'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { ConnectButton, DisconnectButton } from './actions.client'
import { ConnectForm } from './connect-form.client'

export default async function AccountsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const [workspace, accounts, providers] = await Promise.all([
    getWorkspace(workspaceId),
    getAccounts(workspaceId),
    getProviders(),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!accounts.ok) return <ErrorCard message={accounts.message} requestId={accounts.requestId} />

  const canConnect = workspace.data.permissions.includes('accounts.connect')
  const active = accounts.data.filter((a) => a.status !== 'DISCONNECTED')
  const disconnected = accounts.data.filter((a) => a.status === 'DISCONNECTED')

  return (
    <>
      <PageHeader title="Social accounts" description="Channels this workspace can publish to." />

      {active.length === 0 ? (
        <EmptyState
          title="No accounts connected"
          hint="Connect a channel to start scheduling. The mock provider works with no developer credentials at all."
        />
      ) : (
        <div className="space-y-2">
          {active.map((a) => (
            <Card key={a.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{a.displayName}</p>
                  {a.status === 'NEEDS_REAUTH' && <Badge tone="warn">needs reconnect</Badge>}
                </div>
                <p className="truncate text-xs">
                  <Muted>
                    {a.handle} · {a.provider}
                  </Muted>
                </p>
                {a.statusReason && (
                  <p className="mt-1 text-xs">
                    <Muted>{a.statusReason}</Muted>
                  </p>
                )}
              </div>
              {canConnect && (
                <DisconnectButton workspaceId={workspaceId} accountId={a.id} name={a.displayName} />
              )}
            </Card>
          ))}
        </div>
      )}

      {disconnected.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Disconnected</h2>
          <p className="mt-1 text-sm">
            {/* Kept, not deleted: published history and past metrics would
                otherwise lose their attribution along with the connection. */}
            <Muted>Kept so published history and past metrics stay attributed.</Muted>
          </p>
          <div className="mt-2 space-y-2">
            {disconnected.map((a) => (
              <Card key={a.id} className="p-3">
                <p className="text-sm">
                  <Muted>
                    {a.displayName} · {a.handle}
                  </Muted>
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium">Available providers</h2>
        <p className="mt-1 text-sm">
          <Muted>
            A provider is disabled either because it is not built yet, or because your administrator
            has not configured it. Those are different problems, so the reason is always stated
            rather than the provider simply being missing.
          </Muted>
        </p>

        <div className="mt-3 space-y-2">
          {providers.ok ? (
            providers.data.map((p) => (
              <Card
                key={p.id}
                // A stable handle for the end-to-end suite. The alternative is
                // a locator that walks the DOM by class name, which breaks the
                // next time this card is restyled — and a test that breaks on
                // restyling teaches people to distrust the suite.
                data-testid={`provider-${p.id}`}
                className="flex flex-wrap items-start justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{p.label}</p>
                    {p.state === 'mock' && <Badge>simulator</Badge>}
                    {p.state === 'skeleton' && <Badge>not built yet</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs">
                    <Muted>{p.disabledReason ?? capabilitySummary(p.capabilities)}</Muted>
                  </p>

                  {/* A caveat on a connector that works. Rendered in warning
                      colour and BEFORE anyone connects, because the failure it
                      describes is invisible afterwards: the API returns success
                      and the post reaches nobody. */}
                  {p.notice && (
                    <p className="mt-1.5 max-w-prose text-xs text-warning">{p.notice}</p>
                  )}
                </div>
                {/* Which control appears comes from the provider's own
                    declaration, not from a list here — so a new connector of
                    either kind needs no change to this page. A form is shown
                    whenever anything must be collected first, whether that is
                    the whole credential or just a Mastodon instance. */}
                {p.connectFields.length > 0 ? (
                  <ConnectForm
                    workspaceId={workspaceId}
                    provider={p.id}
                    label={p.label}
                    fields={[...p.connectFields]}
                    authStyle={p.authStyle}
                    disabled={!canConnect || Boolean(p.disabledReason)}
                  />
                ) : (
                  <ConnectButton
                    workspaceId={workspaceId}
                    provider={p.id}
                    disabled={!canConnect || Boolean(p.disabledReason)}
                  />
                )}
              </Card>
            ))
          ) : (
            <ErrorCard message={providers.message} requestId={providers.requestId} />
          )}
        </div>
      </section>
    </>
  )
}

/**
 * Built from the capability matrix the API serves, never from a hard-coded list.
 * That is what keeps "never claim unsupported functionality" structural rather
 * than a discipline someone has to remember when adding a provider.
 */
function capabilitySummary(capabilities: Record<string, boolean>): string {
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
