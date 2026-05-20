import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

/**
 * @import { Construct } from 'constructs'
 */

const CONTAINER_UID = '1000'
const CONTAINER_GID = '1000'
const CENTRAL_PORT = 8788
const RENDEZVOUS_PORT = 8789
const CENTRAL_CONFIG_ENV = 'COLLECTIVUS_SERVER_CONFIG'
const IDENTITY_SECRET_ENV = 'COLLECTIVUS_IDENTITY_ISSUER_SECRET'
const RENDEZVOUS_TOKEN_ENV = 'COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN'
const DEFAULT_IMAGE_URI = 'ghcr.io/hyparam/collectivus:latest'
const DEFAULT_UPLOAD_PREFIX = 'collectivus'
const DEFAULT_UPLOAD_TIME = '00:10'
const UPLOAD_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export class CollectivusEcsStack extends cdk.Stack {
  /**
   * @param {Construct} scope
   * @param {string} id
   * @param {cdk.StackProps} [props]
   */
  constructor(scope, id, props = {}) {
    super(scope, id, props)

    const settings = readSettings(this)
    const vpc = settings.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: settings.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
        maxAzs: settings.vpcMaxAzs,
        natGateways: settings.natGateways,
      })
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc })

    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    })

    const centralTaskRole = createTaskRole(this, 'CentralTaskRole')
    const rendezvousTaskRole = createTaskRole(this, 'RendezvousTaskRole')
    const fileSystem = new efs.FileSystem(this, 'StateFileSystem', {
      allowAnonymousAccess: true,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpc,
    })
    const centralAccessPoint = createAccessPoint(fileSystem, 'CentralAccessPoint', '/central')
    const rendezvousAccessPoint = createAccessPoint(fileSystem, 'RendezvousAccessPoint', '/rendezvous')
    grantEfsAccess(fileSystem, centralTaskRole)
    grantEfsAccess(fileSystem, rendezvousTaskRole)

    const identitySecret = new secretsmanager.Secret(this, 'IdentityIssuerSecret', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const rendezvousRegistrationToken = new secretsmanager.Secret(this, 'RendezvousRegistrationToken', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const image = ecs.ContainerImage.fromRegistry(settings.imageUri)
    archiveBucket.grantReadWrite(centralTaskRole)
    const centralTaskDefinition = createTaskDefinition(this, 'CentralTaskDefinition', settings, centralTaskRole)
    addEfsVolume(centralTaskDefinition, fileSystem, centralAccessPoint, 'central-state')
    const centralContainer = centralTaskDefinition.addContainer('CentralContainer', {
      command: ['--config-env', CENTRAL_CONFIG_ENV],
      containerName: 'collectivus-central',
      image,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: createLogGroup(this, 'CentralLogGroup'),
        streamPrefix: 'central',
      }),
      secrets: {
        [IDENTITY_SECRET_ENV]: ecs.Secret.fromSecretsManager(identitySecret),
        [RENDEZVOUS_TOKEN_ENV]: ecs.Secret.fromSecretsManager(rendezvousRegistrationToken),
      },
    })
    centralContainer.addPortMappings({ containerPort: CENTRAL_PORT, protocol: ecs.Protocol.TCP })
    centralContainer.addMountPoints({
      containerPath: '/data',
      readOnly: false,
      sourceVolume: 'central-state',
    })

    const centralCertificate = importCertificate(this, 'CentralCertificate', settings.centralCertificateArn)
    const centralService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'CentralService', {
      certificate: centralCertificate,
      cluster,
      circuitBreaker: { rollback: true },
      desiredCount: settings.desiredCount,
      enableExecuteCommand: settings.enableExecuteCommand,
      listenerPort: centralCertificate ? 443 : 80,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      protocol: centralCertificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      publicLoadBalancer: settings.publicLoadBalancer,
      redirectHTTP: Boolean(centralCertificate),
      taskDefinition: centralTaskDefinition,
    })
    centralService.targetGroup.configureHealthCheck({ path: '/health' })
    fileSystem.connections.allowDefaultPortFrom(centralService.service)
    const centralPublicUrl = serviceUrl(
      centralService,
      centralCertificate ? 'https' : 'http',
      settings.centralPublicUrl
    )
    centralContainer.addEnvironment(CENTRAL_CONFIG_ENV, cdk.Lazy.string({
      produce: () => JSON.stringify({
        role: 'server',
        server: {
          control_plane_listen: `0.0.0.0:${CENTRAL_PORT}`,
          data_dir: '/data/server',
          identity_issuer: {
            bootstrap_store_path: '/data/server/bootstrap.json',
            secret_env: IDENTITY_SECRET_ENV,
          },
          public_url: centralPublicUrl,
          sink_dir: '/data/server/ingest',
        },
        upload: {
          bucket: archiveBucket.bucketName,
          prefix: settings.uploadPrefix,
          region: cdk.Stack.of(this).region,
          time: settings.uploadTime,
        },
        version: 1,
      }),
    }))

    const rendezvousTaskDefinition = createTaskDefinition(this, 'RendezvousTaskDefinition', settings, rendezvousTaskRole)
    addEfsVolume(rendezvousTaskDefinition, fileSystem, rendezvousAccessPoint, 'rendezvous-state')
    const rendezvousContainer = rendezvousTaskDefinition.addContainer('RendezvousContainer', {
      command: [
        'rendezvous',
        '--listen',
        `0.0.0.0:${RENDEZVOUS_PORT}`,
        '--data-dir',
        '/data/rendezvous',
      ],
      containerName: 'collectivus-rendezvous',
      image,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: createLogGroup(this, 'RendezvousLogGroup'),
        streamPrefix: 'rendezvous',
      }),
      secrets: {
        [RENDEZVOUS_TOKEN_ENV]: ecs.Secret.fromSecretsManager(rendezvousRegistrationToken),
      },
    })
    rendezvousContainer.addPortMappings({ containerPort: RENDEZVOUS_PORT, protocol: ecs.Protocol.TCP })
    rendezvousContainer.addMountPoints({
      containerPath: '/data',
      readOnly: false,
      sourceVolume: 'rendezvous-state',
    })

    const rendezvousCertificate = importCertificate(this, 'RendezvousCertificate', settings.rendezvousCertificateArn)
    const rendezvousService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'RendezvousService', {
      certificate: rendezvousCertificate,
      cluster,
      circuitBreaker: { rollback: true },
      desiredCount: settings.desiredCount,
      enableExecuteCommand: settings.enableExecuteCommand,
      listenerPort: rendezvousCertificate ? 443 : 80,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      protocol: rendezvousCertificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      publicLoadBalancer: settings.publicLoadBalancer,
      redirectHTTP: Boolean(rendezvousCertificate),
      taskDefinition: rendezvousTaskDefinition,
    })
    rendezvousService.targetGroup.configureHealthCheck({ path: '/health' })
    fileSystem.connections.allowDefaultPortFrom(rendezvousService.service)

    const rendezvousUrl = serviceUrl(
      rendezvousService,
      rendezvousCertificate ? 'https' : 'http',
      settings.rendezvousPublicUrl
    )

    new cdk.CfnOutput(this, 'ArchiveBucketName', { value: archiveBucket.bucketName })
    new cdk.CfnOutput(this, 'CentralServiceName', { value: centralService.service.serviceName })
    new cdk.CfnOutput(this, 'CentralUrl', { value: centralPublicUrl })
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName })
    new cdk.CfnOutput(this, 'IdentityIssuerSecretArn', { value: identitySecret.secretArn })
    new cdk.CfnOutput(this, 'RendezvousRegistrationTokenSecretArn', {
      value: rendezvousRegistrationToken.secretArn,
    })
    new cdk.CfnOutput(this, 'RendezvousServiceName', { value: rendezvousService.service.serviceName })
    new cdk.CfnOutput(this, 'RendezvousUrl', { value: rendezvousUrl })
  }
}

/**
 * @param {Construct} scope
 * @returns {{
 *   centralCertificateArn?: string,
 *   centralPublicUrl?: string,
 *   cpu: number,
 *   desiredCount: number,
 *   enableExecuteCommand: boolean,
 *   imageUri: string,
 *   memoryLimitMiB: number,
 *   natGateways: number,
 *   publicLoadBalancer: boolean,
 *   rendezvousCertificateArn?: string,
 *   rendezvousPublicUrl?: string,
 *   uploadPrefix: string,
 *   uploadTime: string,
 *   vpcId?: string,
 *   vpcMaxAzs: number,
 * }}
 */
function readSettings(scope) {
  const uploadTime = stringContext(scope, 'uploadTime', DEFAULT_UPLOAD_TIME)
  if (!UPLOAD_TIME_PATTERN.test(uploadTime)) {
    throw new Error('CDK context uploadTime must be HH:MM UTC')
  }
  const desiredCount = positiveIntegerContext(scope, 'desiredCount', 1)
  if (desiredCount !== 1) {
    throw new Error('CDK context desiredCount must remain 1 while Collectivus ECS state is file-backed')
  }

  return {
    centralCertificateArn: optionalStringContext(scope, 'centralCertificateArn'),
    centralPublicUrl: optionalStringContext(scope, 'centralPublicUrl'),
    cpu: positiveIntegerContext(scope, 'cpu', 512),
    desiredCount,
    enableExecuteCommand: booleanContext(scope, 'enableExecuteCommand', true),
    imageUri: stringContext(scope, 'imageUri', DEFAULT_IMAGE_URI),
    memoryLimitMiB: positiveIntegerContext(scope, 'memoryLimitMiB', 1024),
    natGateways: nonNegativeIntegerContext(scope, 'natGateways', 1),
    publicLoadBalancer: booleanContext(scope, 'publicLoadBalancer', true),
    rendezvousCertificateArn: optionalStringContext(scope, 'rendezvousCertificateArn'),
    rendezvousPublicUrl: optionalStringContext(scope, 'rendezvousPublicUrl'),
    uploadPrefix: stringContext(scope, 'uploadPrefix', DEFAULT_UPLOAD_PREFIX),
    uploadTime,
    vpcId: optionalStringContext(scope, 'vpcId'),
    vpcMaxAzs: positiveIntegerContext(scope, 'vpcMaxAzs', 2),
  }
}

/**
 * @param {Construct} scope
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function stringContext(scope, key, fallback) {
  const value = scope.node.tryGetContext(key)
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

/**
 * @param {Construct} scope
 * @param {string} key
 * @returns {string | undefined}
 */
function optionalStringContext(scope, key) {
  const value = scope.node.tryGetContext(key)
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

/**
 * @param {Construct} scope
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntegerContext(scope, key, fallback) {
  const value = scope.node.tryGetContext(key)
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`CDK context ${key} must be a positive integer`)
  }
  return parsed
}

/**
 * @param {Construct} scope
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeIntegerContext(scope, key, fallback) {
  const value = scope.node.tryGetContext(key)
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`CDK context ${key} must be a non-negative integer`)
  }
  return parsed
}

/**
 * @param {Construct} scope
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function booleanContext(scope, key, fallback) {
  const value = scope.node.tryGetContext(key)
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`CDK context ${key} must be true or false`)
}

/**
 * @param {Construct} scope
 * @param {string} id
 * @returns {iam.Role}
 */
function createTaskRole(scope, id) {
  return new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  })
}

/**
 * @param {Construct} scope
 * @param {string} id
 * @returns {logs.LogGroup}
 */
function createLogGroup(scope, id) {
  return new logs.LogGroup(scope, id, {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_MONTH,
  })
}

/**
 * @param {Construct} scope
 * @param {string} id
 * @param {{ cpu: number, memoryLimitMiB: number }} settings
 * @param {iam.IRole} taskRole
 * @returns {ecs.FargateTaskDefinition}
 */
function createTaskDefinition(scope, id, settings, taskRole) {
  return new ecs.FargateTaskDefinition(scope, id, {
    cpu: settings.cpu,
    memoryLimitMiB: settings.memoryLimitMiB,
    taskRole,
  })
}

/**
 * @param {efs.FileSystem} fileSystem
 * @param {string} id
 * @param {string} path
 * @returns {efs.AccessPoint}
 */
function createAccessPoint(fileSystem, id, path) {
  return fileSystem.addAccessPoint(id, {
    createAcl: {
      ownerGid: CONTAINER_GID,
      ownerUid: CONTAINER_UID,
      permissions: '750',
    },
    path,
    posixUser: {
      gid: CONTAINER_GID,
      uid: CONTAINER_UID,
    },
  })
}

/**
 * @param {efs.FileSystem} fileSystem
 * @param {iam.IRole} taskRole
 * @returns {void}
 */
function grantEfsAccess(fileSystem, taskRole) {
  fileSystem.grantReadWrite(taskRole)
}

/**
 * @param {ecs.FargateTaskDefinition} taskDefinition
 * @param {efs.FileSystem} fileSystem
 * @param {efs.AccessPoint} accessPoint
 * @param {string} name
 * @returns {void}
 */
function addEfsVolume(taskDefinition, fileSystem, accessPoint, name) {
  taskDefinition.addVolume({
    efsVolumeConfiguration: {
      authorizationConfig: {
        accessPointId: accessPoint.accessPointId,
        iam: 'ENABLED',
      },
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'ENABLED',
    },
    name,
  })
}

/**
 * @param {Construct} scope
 * @param {string} id
 * @param {string | undefined} certificateArn
 * @returns {acm.ICertificate | undefined}
 */
function importCertificate(scope, id, certificateArn) {
  return certificateArn
    ? acm.Certificate.fromCertificateArn(scope, id, certificateArn)
    : undefined
}

/**
 * @param {ecsPatterns.ApplicationLoadBalancedFargateService} service
 * @param {'http' | 'https'} protocol
 * @param {string | undefined} override
 * @returns {string}
 */
function serviceUrl(service, protocol, override) {
  return override ?? cdk.Fn.join('', [`${protocol}://`, service.loadBalancer.loadBalancerDnsName])
}
