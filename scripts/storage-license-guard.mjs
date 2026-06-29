import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const strictStorage = process.argv.includes('--strict-storage')
const allowCDrive =
  process.env.TOKOMETER_ALLOW_C_DRIVE === '1' ||
  process.env.TOKOMETER_ALLOW_C_DRIVE === 'true'
const isWindows = process.platform === 'win32'
const errors = []
const warnings = []

async function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8')
}

function addStorageIssue(message) {
  if (strictStorage) {
    errors.push(message)
  } else {
    warnings.push(message)
  }
}

function isCDrive(targetPath) {
  if (!isWindows || !targetPath) {
    return false
  }

  return path.parse(path.resolve(targetPath)).root.toLowerCase() === 'c:\\'
}

function assertIncludes(fileName, text, needle) {
  if (!text.includes(needle)) {
    errors.push(`${fileName} is missing required text: ${needle}`)
  }
}

async function checkLicenseMarkers() {
  const packageJson = JSON.parse(await readText('package.json'))
  const packageLock = JSON.parse(await readText('package-lock.json'))
  const license = await readText('LICENSE')
  const readme = await readText('README.md')
  const notice = await readText('NOTICE.md')
  const commercial = await readText('COMMERCIAL-LICENSE.md')

  if (packageJson.license !== 'SEE LICENSE IN LICENSE') {
    errors.push('package.json must use "SEE LICENSE IN LICENSE".')
  }

  if (packageLock.packages?.['']?.license !== 'SEE LICENSE IN LICENSE') {
    errors.push('package-lock.json root package must use "SEE LICENSE IN LICENSE".')
  }

  for (const bundledFile of ['LICENSE', 'NOTICE.md', 'COMMERCIAL-LICENSE.md']) {
    if (!packageJson.build?.files?.includes(bundledFile)) {
      errors.push(`package.json build.files must include ${bundledFile}.`)
    }
  }

  assertIncludes('LICENSE', license, 'PolyForm Noncommercial License 1.0.0')
  assertIncludes('LICENSE', license, 'Commercial use')
  assertIncludes('README.md', readme, 'Commercial use requires a separate written license from TWO HANDS NETWORK LTD')
  assertIncludes('README.md', readme, 'COO of TWO HANDS NETWORK LTD')
  assertIncludes('NOTICE.md', notice, 'source-available software, not open-source software')
  assertIncludes('NOTICE.md', notice, 'COO of TWO HANDS NETWORK LTD')
  assertIncludes('COMMERCIAL-LICENSE.md', commercial, 'Commercial use is not included in the public license')
  assertIncludes('COMMERCIAL-LICENSE.md', commercial, 'COO of TWO HANDS NETWORK LTD')
}

async function checkStorageMarkers() {
  const packageJson = JSON.parse(await readText('package.json'))
  const releaseOutput = packageJson.build?.directories?.output ?? 'release'
  const generatedPaths = [
    repoRoot,
    path.resolve(repoRoot, releaseOutput),
    path.resolve(repoRoot, 'dist'),
    path.resolve(repoRoot, 'dist-server'),
  ]
  const configuredPaths = [
    ['TOKEN_GAUGE_DATA_DIR', process.env.TOKEN_GAUGE_DATA_DIR],
    ['TOKOMETER_TEMP_DIR', process.env.TOKOMETER_TEMP_DIR],
    ['npm_config_cache', process.env.npm_config_cache],
  ]

  if (!allowCDrive) {
    for (const targetPath of generatedPaths) {
      if (isCDrive(targetPath)) {
        addStorageIssue(`Generated Tokometer path is on C drive: ${targetPath}`)
      }
    }

    for (const [name, targetPath] of configuredPaths) {
      if (targetPath && isCDrive(targetPath)) {
        addStorageIssue(`${name} points at C drive: ${targetPath}`)
      }
    }
  }

  if (isWindows && !process.env.TOKEN_GAUGE_DATA_DIR) {
    warnings.push(
      'TOKEN_GAUGE_DATA_DIR is not set; Windows runtime defaults to %APPDATA% unless redirected by a junction.',
    )
  }
}

await checkLicenseMarkers()
await checkStorageMarkers()

for (const warning of warnings) {
  console.warn(`Guard warning: ${warning}`)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`Guard error: ${error}`)
  }
  process.exit(1)
}

console.log(
  `Storage/licence guard passed${strictStorage ? ' in strict mode' : ''}.`,
)
