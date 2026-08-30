import { redirect } from 'next/navigation'
import { getWorkspaces } from '@/lib/api'

export default async function Home() {
  const workspaces = await getWorkspaces()
  if (!workspaces.ok || workspaces.data.length === 0) redirect('/login')
  redirect(`/w/${workspaces.data[0]!.id}/dashboard`)
}
