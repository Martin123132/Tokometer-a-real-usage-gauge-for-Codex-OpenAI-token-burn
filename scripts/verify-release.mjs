import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
)
const releaseDir = path.join(repoRoot, 'release')
const productName = packageJson.build?.productName ?? packageJson.name
const version = packageJson.version
const writeChecksums = process.argv.includes('--write')

const requiredArtifacts = [
  `${productName} Setup ${version}.exe`,
  `${productName} ${version}.exe`,
]

function formatBytes(value) {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${value} B`
}

async function sha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex').toUpperCase()
}

async function assertRequiredArtifacts() {
  const missing = []

  for (const artifact of requiredArtifacts) {
    const artifactPath = path.join(releaseDir, artifact)
    try {
      const artifactStat = await stat(artifactPath)
      if (artifactStat.size < 1024 * 1024) {
        throw new Error(
          `${artifact} is unexpectedly small (${formatBytes(artifactStat.size)})`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpectedly small')) {
        throw error
      }
      missing.push(artifact)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing release artifacts: ${missing.join(', ')}`)
  }
}

async function main() {
  await assertRequiredArtifacts()

  const files = (await readdir(releaseDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith('.sha256'))
    .sort((a, b) => a.localeCompare(b))

  if (files.length === 0) {
    throw new Error('No release files found.')
  }

  console.log(`Verified ${requiredArtifacts.length} required artifacts.`)

  for (const file of files) {
    const filePath = path.join(releaseDir, file)
    const fileStat = await stat(filePath)
    const digest = await sha256(filePath)
    const line = `${digest}  ${file}`
    console.log(`${line} (${formatBytes(fileStat.size)})`)

    if (writeChecksums) {
      await writeFile(`${filePath}.sha256`, `${line}\n`, 'utf8')
    }
  }

  if (writeChecksums) {
    console.log('Wrote SHA256 checksum files.')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
