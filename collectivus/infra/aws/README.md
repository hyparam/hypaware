# Collectivus ECS CDK

This CDK app deploys Collectivus to ECS Fargate:

- Central server service on port `8788`, configured as the collector/archive
  endpoint and granted write access to a new private S3 bucket.
- Rendezvous service on port `8789`, backed by its own EFS state directory.
- One ECS cluster, two application load balancers, encrypted EFS state, CloudWatch
  log groups, and Secrets Manager secrets for the Central JWT issuer secret and
  rendezvous registration token.

The stack uses the public GHCR image by default:

```bash
ghcr.io/hyparam/collectivus:latest
```

## Prerequisites

Bootstrap the AWS account and region once:

```bash
cd infra/aws
npm install
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

## Deploy

For an HTTP test deployment:

```bash
cd infra/aws
npm run deploy -- \
  -c imageUri=ghcr.io/hyparam/collectivus:latest
```

For a production deployment with existing ACM certificates:

```bash
cd infra/aws
npm run deploy -- \
  -c imageUri=ghcr.io/hyparam/collectivus:latest \
  -c centralCertificateArn=arn:aws:acm:REGION:ACCOUNT:certificate/CENTRAL_CERT_ID \
  -c rendezvousCertificateArn=arn:aws:acm:REGION:ACCOUNT:certificate/RENDEZVOUS_CERT_ID \
  -c centralPublicUrl=https://collectivus.example.com \
  -c rendezvousPublicUrl=https://join.collectivus.example.com
```

The public URL contexts should match the DNS names gateways will use. Point
your DNS records at the load balancer DNS names shown in the stack outputs.

## Configuration

Context values:

| Key | Default | Notes |
|-----|---------|-------|
| `imageUri` | `ghcr.io/hyparam/collectivus:latest` | Container image for both services. |
| `centralPublicUrl` | Central ALB URL | Set this to the DNS name gateways use. Required for useful rendezvous-issued join commands. |
| `rendezvousPublicUrl` | Rendezvous ALB URL | Set this to the DNS name operators give to gateways. |
| `centralCertificateArn` | none | Enables HTTPS listener and HTTP redirect for Central. |
| `rendezvousCertificateArn` | none | Enables HTTPS listener and HTTP redirect for rendezvous. |
| `uploadPrefix` | `collectivus` | S3 key prefix for Parquet uploads. |
| `uploadTime` | `00:10` | Daily upload time in UTC. |
| `desiredCount` | `1` | Must remain `1` while Central and rendezvous use file-backed state. Deployments stop the old task before starting the replacement to avoid two writers on the same EFS state. |
| `enableExecuteCommand` | `true` | Enables ECS Exec for operator commands in the Central task. |
| `cpu` | `512` | Fargate CPU units for each task. |
| `memoryLimitMiB` | `1024` | Fargate memory for each task. |
| `vpcId` | new VPC | Use an existing VPC by ID. |
| `vpcMaxAzs` | `2` | Used only when creating a new VPC. |
| `natGateways` | `1` | Used only when creating a new VPC. |
| `publicLoadBalancer` | `true` | Set to `false` for internal ALBs. |

## Secrets

Fetch the rendezvous registration token for operator commands:

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(aws cloudformation describe-stacks \
    --stack-name CollectivusEcsStack \
    --query 'Stacks[0].Outputs[?OutputKey==`RendezvousRegistrationTokenSecretArn`].OutputValue' \
    --output text)" \
  --query SecretString \
  --output text
```

Use that value as `COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN` or
`--rendezvous-token` when issuing Central bootstrap tokens.

## Operator Commands

The stack injects the Central config through `COLLECTIVUS_SERVER_CONFIG`, so
operator commands should use `--server-config-env` when run through ECS Exec:

```bash
TASK_ARN=$(aws ecs list-tasks \
  --cluster "$(aws cloudformation describe-stacks --stack-name CollectivusEcsStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)" \
  --service-name "$(aws cloudformation describe-stacks --stack-name CollectivusEcsStack \
    --query 'Stacks[0].Outputs[?OutputKey==`CentralServiceName`].OutputValue' --output text)" \
  --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster "$(aws cloudformation describe-stacks --stack-name CollectivusEcsStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)" \
  --task "$TASK_ARN" \
  --container collectivus-central \
  --interactive \
  --command "node bin/cli.js config bootstrap-token issue acme-gateway --server-config-env COLLECTIVUS_SERVER_CONFIG --rendezvous https://join.collectivus.example.com --max-uses 25"
```

The Central task also receives `COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN` from
Secrets Manager, so `ctvs config bootstrap-token issue --rendezvous ...` can use
the existing environment fallback. With `--rendezvous`, the command prints a
short join key instead of the underlying bootstrap token; each successful join
mints its own one-shot bootstrap token inside Central. `--max-uses` controls how
many gateways can enroll before the key is exhausted, and `--ttl-seconds`
controls the key expiry.
