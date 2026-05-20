#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { CollectivusEcsStack } from '../lib/collectivus-ecs-stack.js'

const app = new cdk.App()

new CollectivusEcsStack(app, 'CollectivusEcsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
