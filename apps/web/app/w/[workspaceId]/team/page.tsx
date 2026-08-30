import { getInvites, getMembers, getWorkspace } from '@/lib/api'
import { Badge, Card, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { InviteForm } from './invite-form.client'

export default async function TeamPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const [workspace, members] = await Promise.all([
    getWorkspace(workspaceId),
    getMembers(workspaceId),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />

  const canManage = workspace.data.permissions.includes('members.manage')
  // Only fetched when permitted. Requesting it regardless would produce a 403 in
  // the network tab on every page load for most roles — noise that trains people
  // to ignore real errors.
  const invites = canManage ? await getInvites(workspaceId) : null

  return (
    <>
      <PageHeader title="Team" description={`People with access to ${workspace.data.name}.`} />

      {!members.ok ? (
        <ErrorCard message={members.message} requestId={members.requestId} />
      ) : (
        <div className="space-y-2">
          {members.data.map((m) => (
            <Card key={m.id} className="flex items-center justify-between p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.user.name}</p>
                <p className="truncate text-xs">
                  <Muted>{m.user.email}</Muted>
                </p>
              </div>
              <Badge tone={m.role === 'OWNER' ? 'accent' : 'neutral'}>{m.role}</Badge>
            </Card>
          ))}
        </div>
      )}

      {canManage && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Invite someone</h2>
          <p className="mt-1 text-sm">
            <Muted>
              The invite link is shown once and never again — only its hash is stored, exactly like
              a session token. A link you can retrieve later is a standing credential.
            </Muted>
          </p>
          <div className="mt-3">
            <InviteForm workspaceId={workspaceId} />
          </div>

          {invites?.ok && invites.data.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-medium">Pending invites</h3>
              <div className="mt-2 space-y-2">
                {invites.data.map((i) => (
                  <Card key={i.id} className="flex items-center justify-between p-3">
                    <p className="truncate text-sm">{i.email}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge>{i.role}</Badge>
                      <span className="text-xs">
                        <Muted>expires {new Date(i.expiresAt).toLocaleDateString()}</Muted>
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  )
}
