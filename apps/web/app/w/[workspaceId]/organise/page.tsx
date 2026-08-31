import { apiGet } from '@/lib/server-fetch'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CampaignForm,
  ArchiveCampaign,
  DeleteThing,
  LabelForm,
  TemplateForm,
  TemplatePreview,
  PresetForm,
  PresetPreview,
} from './organise.client'

type Campaign = {
  id: string
  name: string
  description: string | null
  color: string
  startsAt: string | null
  endsAt: string | null
  archived: boolean
  postCount: number
}

type Label = { id: string; name: string; color: string; postCount: number }

type Template = {
  id: string
  name: string
  description: string | null
  body: string
  variables: string[]
  usageCount: number
}

type Preset = {
  id: string
  name: string
  source: string
  medium: string
  campaign: string | null
  term: string | null
  content: string | null
  isDefault: boolean
  variables: string[]
}

/** A UTM parameter and its value. Not Stat: these are strings, not figures. */
function Param({ name, value }: { name: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs text-muted-foreground">{name}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  )
}

function dateRange(startsAt: string | null, endsAt: string | null): string | null {
  if (!startsAt && !endsAt) return null
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  if (startsAt && endsAt) return `${fmt(startsAt)} – ${fmt(endsAt)}`
  if (startsAt) return `from ${fmt(startsAt)}`
  return `until ${fmt(endsAt!)}`
}

export default async function OrganisePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params

  // Four independent fetches, issued together. Sequential awaits would make the
  // page as slow as the sum of them for no reason — none depends on another.
  const [campaigns, labels, templates, presets] = await Promise.all([
    apiGet<Campaign[]>(`/api/v1/campaigns?workspaceId=${workspaceId}&includeArchived=true`),
    apiGet<Label[]>(`/api/v1/labels?workspaceId=${workspaceId}`),
    apiGet<Template[]>(`/api/v1/templates?workspaceId=${workspaceId}`),
    apiGet<Preset[]>(`/api/v1/utm-presets?workspaceId=${workspaceId}`),
  ])

  // One failure is reported on its own rather than replacing the whole page:
  // labels being unavailable is no reason to hide working campaigns.
  const firstError = [campaigns, labels, templates, presets].find((r) => !r.ok)
  if (firstError && !firstError.ok && !campaigns.ok) {
    return <ErrorCard message={firstError.message} requestId={firstError.requestId} />
  }

  const active = campaigns.ok ? campaigns.data.filter((c) => !c.archived) : []
  const archived = campaigns.ok ? campaigns.data.filter((c) => c.archived) : []

  return (
    <>
      <PageHeader
        title="Organise"
        description="Campaigns group posts, labels categorise them, templates save what you write twice, and UTM presets tag the links."
      />

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="utm">UTM presets</TabsTrigger>
        </TabsList>

        {/* -- Campaigns ------------------------------------------------- */}
        <TabsContent value="campaigns">
          <CampaignForm workspaceId={workspaceId} />

          {!campaigns.ok ? (
            <ErrorCard message={campaigns.message} requestId={campaigns.requestId} />
          ) : campaigns.data.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              hint="A campaign groups posts that belong to one push, so you can see them together on the calendar and compare them afterwards."
            />
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                {active.map((campaign) => (
                  <Card key={campaign.id} data-card="campaign" className="flex items-start gap-3 p-4">
                    <span
                      className="mt-1 size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: campaign.color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{campaign.name}</p>
                      {campaign.description && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {campaign.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs">
                        <Muted>
                          {campaign.postCount} post{campaign.postCount === 1 ? '' : 's'}
                          {dateRange(campaign.startsAt, campaign.endsAt)
                            ? ` · ${dateRange(campaign.startsAt, campaign.endsAt)}`
                            : ''}
                        </Muted>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <ArchiveCampaign
                        workspaceId={workspaceId}
                        id={campaign.id}
                        archived={false}
                      />
                      <DeleteThing
                        workspaceId={workspaceId}
                        resource="campaigns"
                        id={campaign.id}
                        // Named plainly: deleting a campaign is not deleting its
                        // posts, and someone hesitating over the button deserves
                        // to know that before they click rather than after.
                        confirm={`Delete "${campaign.name}"? Its ${campaign.postCount} post${
                          campaign.postCount === 1 ? '' : 's'
                        } will be kept and simply stop being grouped.`}
                      />
                    </div>
                  </Card>
                ))}
              </div>

              {archived.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Archived
                  </p>
                  <div className="space-y-2">
                    {archived.map((campaign) => (
                      <Card key={campaign.id} className="flex items-center gap-3 p-3 opacity-70">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: campaign.color }}
                          aria-hidden
                        />
                        <p className="min-w-0 flex-1 truncate text-sm">{campaign.name}</p>
                        <Muted>
                          <span className="text-xs">{campaign.postCount} posts</span>
                        </Muted>
                        <ArchiveCampaign workspaceId={workspaceId} id={campaign.id} archived />
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* -- Labels --------------------------------------------------- */}
        <TabsContent value="labels">
          <LabelForm workspaceId={workspaceId} />

          {!labels.ok ? (
            <ErrorCard message={labels.message} requestId={labels.requestId} />
          ) : labels.data.length === 0 ? (
            <EmptyState
              title="No labels yet"
              hint="Labels answer a different question from campaigns: not which push a post belonged to, but what kind of thing it is."
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {labels.data.map((label) => (
                <Card key={label.id} data-card="label" className="flex items-center gap-2 px-3 py-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: label.color }}
                    aria-hidden
                  />
                  <span className="text-sm">{label.name}</span>
                  <Muted>
                    <span className="text-xs tabular">{label.postCount}</span>
                  </Muted>
                  <DeleteThing
                    workspaceId={workspaceId}
                    resource="labels"
                    id={label.id}
                    confirm={`Delete the label "${label.name}"? It will be removed from ${label.postCount} post${
                      label.postCount === 1 ? '' : 's'
                    }.`}
                  />
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* -- Templates ------------------------------------------------ */}
        <TabsContent value="templates">
          <TemplateForm workspaceId={workspaceId} />

          {!templates.ok ? (
            <ErrorCard message={templates.message} requestId={templates.requestId} />
          ) : templates.data.length === 0 ? (
            <EmptyState
              title="No templates yet"
              hint="Save anything you write more than once. Use {{double braces}} for the parts that change."
            />
          ) : (
            <div className="space-y-3">
              {templates.data.map((template) => (
                <Card key={template.id} data-card="template" className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{template.name}</p>
                      {template.description && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {template.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Muted>
                        <span className="text-xs">
                          used {template.usageCount}×
                        </span>
                      </Muted>
                      <DeleteThing
                        workspaceId={workspaceId}
                        resource="templates"
                        id={template.id}
                        confirm={`Delete the template "${template.name}"?`}
                      />
                    </div>
                  </div>

                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
                    {template.body}
                  </pre>

                  {template.variables.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Muted>
                        <span className="text-xs">Needs:</span>
                      </Muted>
                      {template.variables.map((v) => (
                        <Badge key={v} tone="accent">
                          {v}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <TemplatePreview
                    workspaceId={workspaceId}
                    id={template.id}
                    variables={template.variables}
                  />
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* -- UTM presets ---------------------------------------------- */}
        <TabsContent value="utm">
          <PresetForm workspaceId={workspaceId} />

          {!presets.ok ? (
            <ErrorCard message={presets.message} requestId={presets.requestId} />
          ) : presets.data.length === 0 ? (
            <EmptyState
              title="No UTM presets yet"
              hint="A preset tags the links in a post so the traffic shows up attributed. Use {{network}} in a value to have it filled per channel."
            />
          ) : (
            <div className="space-y-3">
              {presets.data.map((preset) => (
                <Card key={preset.id} data-card="preset" className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {preset.name}
                        {preset.isDefault && (
                          <span className="ml-2">
                            <Badge tone="success">default</Badge>
                          </span>
                        )}
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                        <Param name="utm_source" value={preset.source} />
                        <Param name="utm_medium" value={preset.medium} />
                        {preset.campaign && (
                          <Param name="utm_campaign" value={preset.campaign} />
                        )}
                        {preset.term && <Param name="utm_term" value={preset.term} />}
                        {preset.content && <Param name="utm_content" value={preset.content} />}
                      </div>
                    </div>
                    <DeleteThing
                      workspaceId={workspaceId}
                      resource="utm-presets"
                      id={preset.id}
                      confirm={`Delete the preset "${preset.name}"?`}
                    />
                  </div>

                  <PresetPreview
                    workspaceId={workspaceId}
                    id={preset.id}
                    variables={preset.variables}
                  />
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  )
}
