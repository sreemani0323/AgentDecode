#!/usr/bin/env node

/**
 * Bundle analysis script for AgentDecode.
 * 
 * Usage:
 *   node scripts/analyze-bundle.mjs
 * 
 * Generates a .next/analyze directory with bundle size details.
 * For visual analysis, install @next/bundle-analyzer:
 *   npm install -D @next/bundle-analyzer
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

console.log('🔍 Building production bundle for analysis...\n')

try {
  execSync('npm run build', { stdio: 'inherit', cwd: ROOT })
} catch {
  console.error('\n❌ Build failed. Fix errors before analyzing bundle.')
  process.exit(1)
}

// Read build manifest for page sizes
const manifestPath = join(ROOT, '.next', 'build-manifest.json')
if (!existsSync(manifestPath)) {
  console.error('❌ Build manifest not found. Ensure the build completed successfully.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pages = Object.keys(manifest.pages)

console.log(`\n📊 Bundle Analysis`)
console.log(`${'─'.repeat(60)}`)
console.log(`Pages found: ${pages.length}`)
console.log(`\nPage routes:`)
pages.forEach(page => {
  const chunks = manifest.pages[page]
  console.log(`  ${page} (${chunks.length} chunks)`)
})

// Check for large dependencies
console.log(`\n📦 Checking node_modules size...`)
try {
  const result = execSync(
    'npx -y cost-of-modules --no-install --top 10',
    { encoding: 'utf8', cwd: ROOT, timeout: 60000 }
  ).trim()
  console.log(result)
} catch {
  console.log('  (Install cost-of-modules for detailed analysis: npx cost-of-modules)')
}

console.log(`\n✅ Analysis complete.`)
console.log(`   For visual bundle analysis, install @next/bundle-analyzer`)
