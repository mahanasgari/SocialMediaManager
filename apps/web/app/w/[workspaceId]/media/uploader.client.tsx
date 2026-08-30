'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

/**
 * Upload and library management.
 *
 * The file is sent as a RAW body rather than multipart. The server identifies it
 * by sniffing magic bytes, so a multipart envelope carrying a declared filename
 * and content-type would add parsing for two fields it is going to discard
 * anyway.
 */
export function Uploader({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)

    for (const file of Array.from(files)) {
      const response = await fetch(`/api/v1/media?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': file.name,
          'x-smm-client': 'web',
        },
        body: file,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        // Names the accepted formats, so "rejected" becomes "convert to this".
        setError(`${file.name}: ${body?.error?.message ?? 'Upload failed.'}`)
        setBusy(false)
        return
      }
    }

    setBusy(false)
    router.refresh()
  }

  return (
    <>
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void upload(e.dataTransfer.files)
        }}
        className="block cursor-pointer rounded-lg border border-dashed p-8 text-center"
        style={{
          borderColor: dragOver ? 'hsl(var(--primary))' : 'hsl(var(--border))',
          background: dragOver ? 'hsl(var(--primary) / 0.05)' : 'transparent',
        }}
      >
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime"
          className="sr-only"
          onChange={(e) => void upload(e.target.files)}
        />
        <p className="text-sm font-medium">{busy ? 'Uploading…' : 'Drop files here, or click'}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          JPEG, PNG, GIF, WebP, MP4 or MOV. Type is checked by reading the file, not by its name.
        </p>
      </label>

      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function DeleteMedia({ workspaceId, mediaId }: { workspaceId: string; mediaId: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)

  return confirming ? (
    <span className="text-xs">
      <button
        type="button"
        onClick={async () => {
          await fetch(`/api/v1/media/${mediaId}?workspaceId=${workspaceId}`, {
            method: 'DELETE',
            headers: { 'x-smm-client': 'web' },
          })
          router.refresh()
        }}
        className="underline"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="ml-2 underline text-muted-foreground"
      >
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-xs underline text-muted-foreground"
    >
      Delete
    </button>
  )
}
