#!/usr/bin/env node
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(repoRoot, 'src')
const indexJsonPath = join(repoRoot, 'index.json')

async function fileExists(path) {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Compiles src/source.json (+ optional src/source.js) into root index.json.
 * For music sources, source.js is inlined into doc.jsLib if present.
 *
 * @param {{ write?: boolean }} options
 * @returns {Promise<string>}
 */
export async function compile({ write = true } = {}) {
  const jsonPath = join(srcDir, 'source.json')
  if (!(await fileExists(jsonPath))) {
    throw new Error(`Source JSON not found at ${jsonPath}`)
  }

  const rawJson = await readFile(jsonPath, 'utf8')
  let doc
  try {
    doc = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`Failed to parse ${jsonPath}: ${err.message}`)
  }

  const jsPath = join(srcDir, 'source.js')
  if (await fileExists(jsPath)) {
    const jsContent = (await readFile(jsPath, 'utf8')).trim()
    if (jsContent.length > 0) {
      doc.jsLib = jsContent
    }
  }

  const outputContent = JSON.stringify(doc, null, 2) + '\n'

  if (write) {
    await writeFile(indexJsonPath, outputContent, 'utf8')
    console.log(`Compiled src/ -> index.json (${Buffer.byteLength(outputContent)} bytes)`)
  }

  return outputContent
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compile().catch((err) => {
    console.error(`Compile failed: ${err.message}`)
    process.exitCode = 1
  })
}
