import { getAccounts, getProviders, getWorkspace, type ProviderDescriptor } from '@/lib/api'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { DisconnectButton } from './actions.client'
import { ProviderGroup } from './provider-group.client'

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
            groupByNetwork(providers.data).map((routes) => (
              <ProviderGroup
                key={routes[0]!.network}
                workspaceId={workspaceId}
                routes={routes}
                canConnect={canConnect}
              />
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
 * Providers grouped by the network they reach, order preserved.
 *
 * Insertion order matters and is the registry's: the direct connector is
 * registered before its Buffer route, so "Direct" is offered first and a
 * grouped network keeps the position its primary connector had in the list.
 */
function groupByNetwork(providers: ProviderDescriptor[]): ProviderDescriptor[][] {
  const groups = new Map<string, ProviderDescriptor[]>()
  for (const provider of providers) {
    const existing = groups.get(provider.network)
    if (existing) existing.push(provider)
    else groups.set(provider.network, [provider])
  }
  return [...groups.values()]
}
