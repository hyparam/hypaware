// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
import {
  buildManagedProfile,
  renderManagedPreferencesPlist,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'

/**
 * Claude Desktop is not a core-attachable client (LLP 0115#no-attach-on-join,
 * reaffirmed by LLP 0133#one-surface). Its only configuration surface is the
 * root-owned managed-preferences plist an attended `hyp claude-desktop install`
 * places with sudo: XML, not JSON, at an absolute system path, carrying no
 * self-describing undo record. Nothing there is reversible by the core
 * disk-driven undo, so the manifest must declare no `attach_probe` at all -
 * and `hyp detach --client claude-desktop` must be an honest no-op rather than
 * a parse/marker error over a file core cannot read or reverse (#444).
 */

/** @import { ClientDescriptor } from '../../src/core/types.js' */

const MANIFEST_PATH = new URL(
  '../../hypaware-core/plugins-workspace/claude-desktop/hypaware.plugin.json',
  import.meta.url
)

/**
 * The claude-desktop client descriptor exactly as `buildPluginCatalog`
 * derives it from the bundled manifest, so the assertions below bind to the
 * shipped manifest rather than to a hand-written copy of it.
 *
 * @returns {Promise<{ descriptor: ClientDescriptor, client: Record<string, any> }>}
 */
async function loadDescriptor() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  const client = manifest.contributes?.client
  assert.ok(client, 'claude-desktop manifest must still contribute a client descriptor')

  /** @type {ClientDescriptor} */
  const descriptor = {
    plugin: manifest.name,
    name: client.name,
    skillDir: client.skill_dir,
  }
  if (typeof client.agent_dir === 'string') descriptor.agentDir = client.agent_dir
  if (client.attach_probe) descriptor.attachProbe = client.attach_probe
  return { descriptor, client }
}

/**
 * Write the plist `hyp claude-desktop install` actually renders, at the path a
 * `$HOME`-relative probe would resolve the manifest's absolute
 * `/Library/Managed Preferences/...` to (`resolveClientSettingsPath` re-anchors
 * every `settings_file` under `$HOME`, so an absolute one lands here).
 *
 * @param {string} home
 * @returns {Promise<string>}
 */
async function writeManagedPlist(home) {
  const plistPath = path.join(
    home,
    'Library',
    'Managed Preferences',
    'com.anthropic.claudefordesktop.plist'
  )
  await fs.mkdir(path.dirname(plistPath), { recursive: true })
  await fs.writeFile(
    plistPath,
    renderManagedPreferencesPlist(
      buildManagedProfile({
        baseUrl: 'http://127.0.0.1:18521',
        authScheme: 'bearer',
        models: ['claude-sonnet-4-5'],
        helperPath: path.join(home, '.hyp', 'bin', 'hyp-claude-desktop-credential'),
      })
    )
  )
  return plistPath
}

/** @returns {Promise<string>} */
async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-desktop-detach-'))
}

test('the claude-desktop manifest declares no attach_probe', async () => {
  const { client } = await loadDescriptor()
  assert.equal(
    client.attach_probe,
    undefined,
    'Desktop has no reversible settings-file write, so it contributes no attach_probe '
      + '(LLP 0115#no-attach-on-join); the managed plist is placed and undone by '
      + "'hyp claude-desktop install' / 'hyp claude-desktop verify', not by core attach/detach"
  )
})

test('hyp detach --client claude-desktop is a no-op over the managed plist', async () => {
  const home = await makeHome()
  await writeManagedPlist(home)

  const { descriptor } = await loadDescriptor()
  const result = await detachClientFromDisk({ descriptor, homeDir: home, env: {} })

  assert.equal(result.changed, false)
})

test('the managed plist never surfaces as a client attach-probe error', async () => {
  const home = await makeHome()
  await writeManagedPlist(home)

  const { descriptor } = await loadDescriptor()
  const probe = await probeClientAttachFromDescriptor({ descriptor, homeDir: home, env: {} })

  assert.equal(probe.attached, false)
  assert.equal(probe.error, undefined)
})
