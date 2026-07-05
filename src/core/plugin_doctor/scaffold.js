// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @import { ScaffoldKind, ScaffoldResult } from '../../../src/core/plugin_doctor/types.js'
 */

/** @type {ScaffoldKind[]} */
export const SCAFFOLD_KINDS = ['source', 'sink', 'dataset']

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const KERNEL_TYPES = path.join(REPO_ROOT, 'hypaware-plugin-kernel-types.d.ts')

/**
 * Generate a minimal, doctor-clean plugin on disk. The output passes
 * `hyp plugin doctor` with zero diagnostics: the manifest is valid, the
 * entrypoint exports `activate()`, and `activate()` registers exactly
 * the one contribution the manifest declares.
 *
 * The `@import` path to the kernel types is computed relative to the
 * generated `src/index.js`, so type-checking resolves regardless of
 * where the plugin is scaffolded.
 *
 * @param {{ name: string, kind: ScaffoldKind, targetDir: string }} args
 * @returns {Promise<ScaffoldResult>}
 */
export async function scaffoldPlugin({ name, kind, targetDir }) {
  if (!SCAFFOLD_KINDS.includes(kind)) {
    throw new Error(`scaffoldPlugin: unknown kind '${kind}' (expected ${SCAFFOLD_KINDS.join('|')})`)
  }
  const slug = slugFromName(name)
  const pluginDir = path.join(targetDir, slug)
  const srcDir = path.join(pluginDir, 'src')

  // Refuse to clobber an existing plugin directory.
  const exists = await fs.stat(pluginDir).then(() => true, () => false)
  if (exists) {
    throw new Error(`scaffoldPlugin: '${pluginDir}' already exists`)
  }

  await fs.mkdir(srcDir, { recursive: true })

  const typesRel = relImport(srcDir, KERNEL_TYPES)
  const files = {
    'hypaware.plugin.json': manifestTemplate({ name, slug, kind }),
    'src/index.js': indexTemplate({ name, slug, kind, typesRel }),
    'src/types.d.ts': typesTemplate({ slug, kind }),
    'README.md': readmeTemplate({ name, slug, kind }),
  }

  /** @type {string[]} */
  const written = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pluginDir, rel)
    await fs.writeFile(abs, content, 'utf8')
    written.push(abs)
  }

  return { pluginName: name, slug, pluginDir, files: written }
}

/* ---------- templates ---------- */

/**
 * @param {{ name: string, slug: string, kind: ScaffoldKind }} a
 */
function manifestTemplate({ name, slug, kind }) {
  /** @type {Record<string, unknown>} */
  const manifest = {
    schema_version: 1,
    name,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    node_engine: '>=20',
    entrypoint: './src/index.js',
    description: `${slug} ${kind} plugin for HypAware`,
    permissions: [],
    contributes: contributesFor(kind, slug),
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * @param {ScaffoldKind} kind
 * @param {string} slug
 */
function contributesFor(kind, slug) {
  if (kind === 'source') {
    return { sources: [{ name: slug, summary: `${slug} source` }] }
  }
  if (kind === 'sink') {
    return { sinks: [{ name: slug, supports: [], summary: `${slug} sink` }] }
  }
  return { datasets: [{ name: `${datasetName(slug)}`, summary: `${slug} dataset` }] }
}

/**
 * @param {{ name: string, slug: string, kind: ScaffoldKind, typesRel: string }} a
 */
function indexTemplate({ name, slug, kind, typesRel }) {
  const header =
    `// @ts-check\n\n` +
    `/**\n * @import { PluginActivationContext } from '${typesRel}'\n */\n\n` +
    `const PLUGIN_NAME = '${name}'\n\n`

  const body = {
    source: sourceActivate(slug),
    sink: sinkActivate(slug),
    dataset: datasetActivate(slug),
  }[kind]

  return header + body
}

/** @param {string} slug */
function sourceActivate(slug) {
  return (
    `/**\n` +
    ` * Activate the ${slug} plugin.\n` +
    ` *\n` +
    ` * Registers source '${slug}'. The source does not start here -\n` +
    ` * \`start()\` owns the lifecycle and reads config from \`ctx.config\`.\n` +
    ` *\n` +
    ` * @param {PluginActivationContext} ctx\n` +
    ` */\n` +
    `export async function activate(ctx) {\n` +
    `  ctx.sources.register({\n` +
    `    name: '${slug}',\n` +
    `    plugin: PLUGIN_NAME,\n` +
    `    summary: '${slug} source',\n` +
    `    configSection: '${slug}',\n` +
    `    async start(startCtx) {\n` +
    `      startCtx.log.info('${slug}.start')\n` +
    `      // TODO: begin producing rows; return a handle the kernel can stop.\n` +
    `      return {\n` +
    `        async status() {\n` +
    `          return { state: 'ready' }\n` +
    `        },\n` +
    `        async stop() {\n` +
    `          startCtx.log.info('${slug}.stop')\n` +
    `        },\n` +
    `      }\n` +
    `    },\n` +
    `  })\n` +
    `}\n`
  )
}

/** @param {string} slug */
function sinkActivate(slug) {
  return (
    `/**\n` +
    ` * Activate the ${slug} plugin.\n` +
    ` *\n` +
    ` * Registers sink '${slug}'. \`create()\` is called per configured\n` +
    ` * instance; it reads \`ctx.config\` and returns a Sink that exports\n` +
    ` * ready partitions on the sink driver's schedule.\n` +
    ` *\n` +
    ` * @param {PluginActivationContext} ctx\n` +
    ` */\n` +
    `export async function activate(ctx) {\n` +
    `  ctx.sinks.register({\n` +
    `    name: '${slug}',\n` +
    `    plugin: PLUGIN_NAME,\n` +
    `    supports: [],\n` +
    `    async create(sinkCtx) {\n` +
    `      sinkCtx.log.info('${slug}.create')\n` +
    `      return {\n` +
    `        async exportBatch(batch) {\n` +
    `          // TODO: write batch.partitions to your destination.\n` +
    `          return { status: 'exported', partitionsExported: batch.partitions.length }\n` +
    `        },\n` +
    `        async close() {},\n` +
    `      }\n` +
    `    },\n` +
    `  })\n` +
    `}\n`
  )
}

/** @param {string} slug */
function datasetActivate(slug) {
  const ds = datasetName(slug)
  return (
    `/**\n` +
    ` * Activate the ${slug} plugin.\n` +
    ` *\n` +
    ` * Registers dataset '${ds}'. \`createDataSource\` yields rows that\n` +
    ` * match \`schema\`; the kernel caches and indexes them.\n` +
    ` *\n` +
    ` * @param {PluginActivationContext} ctx\n` +
    ` */\n` +
    `export async function activate(ctx) {\n` +
    `  ctx.query.registerDataset({\n` +
    `    name: '${ds}',\n` +
    `    plugin: PLUGIN_NAME,\n` +
    `    schema: [\n` +
    `      { name: 'event_time', type: 'TIMESTAMP', nullable: false },\n` +
    `      { name: 'message', type: 'STRING', nullable: true },\n` +
    `    ],\n` +
    `    primaryTimestampColumn: 'event_time',\n` +
    `    async discoverPartitions() {\n` +
    `      return []\n` +
    `    },\n` +
    `    async refreshPartition() {\n` +
    `      return { rowCount: 0 }\n` +
    `    },\n` +
    `    createDataSource() {\n` +
    `      return {\n` +
    `        // eslint-disable-next-line require-yield\n` +
    `        async *[Symbol.asyncIterator]() {\n` +
    `          // TODO: yield rows shaped like the schema above.\n` +
    `        },\n` +
    `      }\n` +
    `    },\n` +
    `  })\n` +
    `}\n`
  )
}

/**
 * @param {{ slug: string, kind: ScaffoldKind }} a
 */
function typesTemplate({ slug, kind }) {
  return (
    `// Shared interfaces for the ${slug} plugin. Define plugin-local\n` +
    `// types here and import them with @import JSDoc - do not use\n` +
    `// @typedef or inline import('...') types (see CLAUDE.md).\n\n` +
    `export interface ${pascal(slug)}Config {\n` +
    `  // TODO: fields read from ctx.config for this ${kind}.\n` +
    `  enabled?: boolean\n` +
    `}\n`
  )
}

/**
 * @param {{ name: string, slug: string, kind: ScaffoldKind }} a
 */
function readmeTemplate({ name, slug, kind }) {
  return (
    `# ${name}\n\n` +
    `A HypAware ${kind} plugin.\n\n` +
    `## Develop\n\n` +
    '```sh\n' +
    `# Validate the plugin (static checks + dry-run activate):\n` +
    `hyp plugin doctor .\n` +
    '```\n\n' +
    `Edit \`src/index.js\` - the \`activate(ctx)\` function registers the\n` +
    `${kind} '${slug}'. See \`docs/PLUGIN_AUTHORING.md\` in the HypAware repo\n` +
    `for the full authoring guide.\n`
  )
}

/* ---------- helpers ---------- */

/**
 * Relative module specifier from `fromDir` to `toFile`, always
 * POSIX-style and prefixed with `./` so it is a valid import.
 *
 * @param {string} fromDir
 * @param {string} toFile
 */
function relImport(fromDir, toFile) {
  let rel = path.relative(fromDir, toFile).split(path.sep).join('/')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

/**
 * Derive a directory/contribution slug from a (possibly scoped) plugin
 * name: `@acme/widget` → `widget`.
 *
 * @param {string} name
 */
export function slugFromName(name) {
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const slug = tail.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  if (!slug) throw new Error(`scaffoldPlugin: cannot derive a slug from name '${name}'`)
  return slug
}

/** @param {string} slug */
function datasetName(slug) {
  return `${slug.replace(/-/g, '_')}_events`
}

/** @param {string} slug */
function pascal(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}
