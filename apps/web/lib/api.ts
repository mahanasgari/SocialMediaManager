import { apiGet, serverFetch } from './server-fetch'

export type Workspace = {
  id: string
  organizationId: string
  name: string
  slug: string
  timezone: string
  role: string
  /**
   * What the UI may RENDER. Never what decides what the user may DO — every
   * mutation is re-authorized server-side, because a permission list that
   * reaches the browser is a hint, not a control.
   */
  permissions: string[]
}

export type Me = { id: string; email: string; name: string }

export type SocialAccount = {
  id: string
  provider: string
  providerAccountId: string
  handle: string
  displayName: string
  avatarUrl: string | null
  status: 'ACTIVE' | 'NEEDS_REAUTH' | 'DISCONNECTED' | 'DISABLED'
  statusReason: string | null
  lastSyncedAt: string | null
}

export type ProviderDescriptor = {
  id: string
  label: string
  state: 'implemented' | 'skeleton' | 'mock'
  configured: boolean
  capabilities: Record<string, boolean>
  surfaces: string[]
  disabledReason: string | null
  /** Decides which connect control the accounts page renders. */
  authStyle: 'oauth' | 'credentials'
  connectFields: ReadonlyArray<{
    name: string
    label: string
    type: string
    hint?: string
    placeholder?: string
  }>
}

export type Member = {
  id: string
  role: string
  joinedAt: string
  user: { id: string; email: string; name: string; avatarUrl: string | null }
}

export type Invite = {
  id: string
  email: string
  role: string
  expiresAt: string
  createdAt: string
}

export type MediaRow = {
  id: string
  filename: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  altText: string | null
  createdAt: string
}

export type Health = {
  status: string
  dependencies: Array<{ name: string; ok: boolean; latencyMs?: number }>
  security: { rowLevelSecurity: string }
}

export const getMe = () => apiGet<Me>('/api/v1/auth/me')
export const getWorkspaces = () => apiGet<Workspace[]>('/api/v1/workspaces')
export const getWorkspace = (id: string) => apiGet<Workspace>(`/api/v1/workspaces/${id}`)
export const getHealth = () => apiGet<Health>('/api/v1/health')
export const getProviders = () => apiGet<ProviderDescriptor[]>('/api/v1/social-providers')
export const getAccounts = (workspaceId: string) =>
  apiGet<SocialAccount[]>(`/api/v1/social-accounts?workspaceId=${workspaceId}`)
export const getMedia = (workspaceId: string) =>
  apiGet<MediaRow[]>(`/api/v1/media?workspaceId=${workspaceId}`)
export const getMembers = (workspaceId: string) =>
  apiGet<Member[]>(`/api/v1/workspaces/${workspaceId}/members`)
export const getInvites = (workspaceId: string) =>
  apiGet<Invite[]>(`/api/v1/workspaces/${workspaceId}/invites`)

export { serverFetch }
