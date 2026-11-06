#!/usr/bin/env node

const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const timeoutMs = Number(process.env.SMOKE_RENDER_TIMEOUT_MS ?? 10 * 60 * 1000)
const shouldRestart = !process.argv.includes('--skip-restart')

async function request(path, options) {
  const response = await fetch(new URL(path, baseUrl), options)
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path} returned ${response.status}`)
  return response
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/healthz', baseUrl))
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Application did not become healthy within 60 seconds')
}

async function main() {
  await waitForHealth()
  const submission = await request('/api/render', { method: 'POST' })
  const { id: jobId, statusUrl } = await submission.json()
  if (!jobId || !statusUrl) throw new Error('Render submission did not return jobId and statusUrl')

  const deadline = Date.now() + timeoutMs
  let job
  while (Date.now() < deadline) {
    const statusResponse = await request(statusUrl)
    job = await statusResponse.json()
    if (job.status === 'completed') break
    if (job.status === 'failed') throw new Error(`Render failed: ${job.error ?? 'unknown error'}`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (job?.status !== 'completed') throw new Error(`Render did not complete within ${timeoutMs}ms`)

  const videoPath = `/r/${encodeURIComponent(jobId)}`
  const range = await request(videoPath, { headers: { Range: 'bytes=0-11' } })
  if (range.status !== 206) throw new Error(`Video range request returned ${range.status}, expected 206`)
  const prefix = new Uint8Array(await range.arrayBuffer())
  if (String.fromCharCode(...prefix.slice(4, 8)) !== 'ftyp') throw new Error('Rendered file is not an MP4 (missing ftyp signature)')

  const download = await request(`${videoPath}?download=1`)
  const bytes = new Uint8Array(await download.arrayBuffer())
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw new Error('Download did not return a valid MP4')
  console.log(`Render ${jobId} completed; range playback and ${bytes.length}-byte download verified.`)

  if (shouldRestart) {
    const { execFileSync } = await import('node:child_process')
    execFileSync('docker', ['compose', 'restart', 'hyperframes'], { stdio: 'inherit' })
    await waitForHealth()
    const restored = await (await request(statusUrl)).json()
    if (restored.status !== 'completed') throw new Error(`Job state after restart is ${restored.status}`)
    const persisted = await request(`${videoPath}?download=1`)
    const persistedBytes = new Uint8Array(await persisted.arrayBuffer())
    if (persistedBytes.length !== bytes.length || String.fromCharCode(...persistedBytes.slice(4, 8)) !== 'ftyp') {
      throw new Error('Persisted video differs or is invalid after restart')
    }
    execFileSync('docker', ['compose', 'exec', '-T', 'hyperframes', 'ffprobe', '-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'default=noprint_wrappers=1', `/data/videos/${jobId}.mp4`], { stdio: 'inherit' })
    console.log(`Job ${jobId} and video persisted across Compose restart.`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
