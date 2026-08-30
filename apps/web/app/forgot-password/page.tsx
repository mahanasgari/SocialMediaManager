import { apiGet } from '@/lib/server-fetch'
import { ForgotForm } from './forgot.client'

type Capabilities = { deliversMail: boolean }

export default async function ForgotPasswordPage() {
  const caps = await apiGet<Capabilities>('/api/v1/auth/capabilities')

  // Read on the SERVER so the page can be honest before anyone types anything.
  // An installation with no SMTP will never deliver the link, and offering the
  // form without saying so wastes the one person who most needs a real answer.
  const deliversMail = caps.ok ? caps.data.deliversMail : true

  return <ForgotForm deliversMail={deliversMail} />
}
