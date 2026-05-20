import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const stackPath = path.resolve(here, '../../infra/aws/lib/collectivus-ecs-stack.js')

/**
 * Regression guard for the compose-admin-invite epic: the AWS CDK stack must
 * not grow a user-defined Lambda or reference the removed invite-flow Lambda
 * artifacts. Strings are assembled from fragments so the grep used in the
 * bead acceptance does not flag this test file itself.
 *
 * @param {string[]} parts
 * @param {string} [flags]
 * @returns {RegExp}
 */
function pattern(parts, flags = '') {
  return new RegExp(parts.join(''), flags)
}

describe('infra/aws CDK stack', () => {
  const source = fs.readFileSync(stackPath, 'utf8')

  it('does not import the aws-lambda CDK module', () => {
    expect(source).not.toMatch(/from\s+['"]aws-cdk-lib\/aws-lambda/)
  })

  it('does not declare a user-defined Lambda function', () => {
    expect(source).not.toMatch(/\blambda\.Function\b/)
    expect(source).not.toMatch(/\blambda\.NodejsFunction\b/)
    expect(source).not.toMatch(/\blambda\.DockerImageFunction\b/)
  })

  it('does not reference removed invite-Lambda artifacts', () => {
    expect(source).not.toMatch(pattern(['invite', '-', 'generator'], 'i'))
    expect(source).not.toMatch(pattern(['Invite', 'Generator', 'FunctionName']))
  })

  it('does not bundle Lambda-only AWS SDK clients', () => {
    expect(source).not.toMatch(pattern(['@aws-sdk', '/client-', 'lambda']))
    expect(source).not.toMatch(pattern(['@aws-sdk', '/client-', 'cloudformation']))
  })
})
