import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Badge, Card, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { CreateApiKey, RevokeKey } from './api-keys.client'
import { Connectors, type ConnectorProvider, type ConnectorSetting } from './connectors.client'

type ApiKeyRow = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

type ConnectorSettings = {
  editable: boolean
  readOnlyReason?: string
  redirectUriBase: string
  settings: ConnectorSetting[]
  providers: ConnectorProvider[]
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const workspace = await getWorkspace(workspaceId)
  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />

  const canManage = workspace.data.permissions.includes('apikeys.manage')
  const keys = canManage
    ? await apiGet<ApiKeyRow[]>(`/api/v1/api-keys?workspaceId=${workspaceId}`)
    : null

  // Organization-level, so the API decides who may see it rather than this
  // page guessing from a workspace role. A non-admin gets a 404 and the
  // section simply is not rendered — the same answer the API would give.
  const connectors = await apiGet<ConnectorSettings>(
    `/api/v1/connector-settings?organizationId=${workspace.data.organizationId}`
  )

  return (
    <>
      <PageHeader title="Settings" description={workspace.data.name} />

      <Card className="p-4">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt>
            <Muted>Timezone</Muted>
          </dt>
          <dd>{workspace.data.timezone}</dd>
          <dt>
            <Muted>Your role</Muted>
          </dt>
          <dd>{workspace.data.role}</dd>
          <dt>
            <Muted>Slug</Muted>
          </dt>
          <dd className="font-mono text-xs">{workspace.data.slug}</dd>
        </dl>
      </Card>

      {canManage && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">API keys</h2>
          <p className="mt-1 text-sm">
            <Muted>
              For scripts and integrations. A request may present a key or a session cookie — never
              both, because which one applies must not be ambiguous.
            </Muted>
          </p>

          <div className="mt-3">
            <CreateApiKey workspaceId={workspaceId} />
          </div>

          {keys?.ok && keys.data.length > 0 && (
            <div className="mt-6 space-y-2">
              {keys.data.map((k) => (
                <Card key={k.id} className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {k.name}
                      {k.revokedAt && (
                        <span className="ml-2">
                          <Badge>revoked</Badge>
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-xs">
                      <Muted>
                        {k.prefix}… · {k.scopes.join(' ')}
                      </Muted>
                    </p>
                    <p className="text-xs">
                      <Muted>
                        {k.lastUsedAt
                          ? `last used ${new Date(k.lastUsedAt).toLocaleString()}`
                          : 'never used'}
                      </Muted>
                    </p>
                  </div>
                  {!k.revokedAt && <RevokeKey workspaceId={workspaceId} keyId={k.id} />}
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {connectors.ok && (
        <section className="mt-10">
          <h2 className="text-sm font-medium">Connector credentials</h2>
          <p className="mt-1 max-w-2xl text-sm">
            <Muted>
              The app registrations this installation uses to talk to each network. These are yours,
              not per-workspace: one Meta app serves every workspace here. Values are encrypted
              before they are stored and are never sent back to the browser.
            </Muted>
          </p>

          <div className="mt-4">
            <Connectors
              organizationId={workspace.data.organizationId}
              redirectUriBase={connectors.data.redirectUriBase}
              settings={connectors.data.settings}
              providers={connectors.data.providers}
              editable={connectors.data.editable}
              {...(connectors.data.readOnlyReason
                ? { readOnlyReason: connectors.data.readOnlyReason }
                : {})}
            />
          </div>
        </section>
      )}
    </>
  )
}
