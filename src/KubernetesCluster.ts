import { SoftwareSession } from './context'

const crypto = require('crypto')
const request = require('retry-request')
const pino = require('pino')()

import {
  Client1_10 as KubernetesClient,
  config as kubernetesConfig,
  ApiV1NamespacesNamePods
} from 'kubernetes-client'

const STENCILA_CORE_IMAGE = process.env.STENCILA_CORE_IMAGE || 'stencila/core'
const DEFAULT_PORT = 2000
const POD_REQUEST_CPU = parseFloat(process.env.POD_REQUEST_MEM || '') || 50 // As well as limiting pods on the node this is also passed
// to docker's --cpu-shares controlling the relative weighting of containers (since we are setting it to the same value
// for all containers this probably does nothing).
const POD_REQUEST_MEM = parseFloat(process.env.POD_REQUEST_MEM || '') || (50 / 1024) // Just used to limit pods on the node.

const POD_LIMIT_CPU = parseFloat(process.env.POD_LIMIT_CPU || '') || 1000 // Enforced by kubernetes within 100ms intervals
const POD_LIMIT_MEM = parseFloat(process.env.POD_LIMIT_MEM || '') || 1.2 // converted to an integer, and used as the value of the
// --memory flag in the docker run command

// Inter-pod affinity for session pods
// A number between 0 and 100
// See https://kubernetes.io/docs/concepts/configuration/assign-pod-node/#inter-pod-affinity-and-anti-affinity-beta-feature
const SESSION_AFFINITY = parseInt(process.env.SESSION_AFFINITY || '0', 10) || 0

class KubernetesClusterOptions {
  public listRefresh: number

  constructor (listRefresh: number) {
    this.listRefresh = listRefresh
  }
}

interface PodMetadata {
  name: string
  creationTimestamp: number
}

interface PodStatus {
  podIP: string
  phase: string
}

interface PodDescription {
  metadata: PodMetadata
  status: PodStatus
}

class SessionDescription {
  pendingPosition: number

  constructor (public id: string, public ip: string, public port: number, public created: number, public status: string) {
    this.pendingPosition = -1
  }
}

interface NameValuePair {
  name: string
  value: string
}

enum ImagePullPolicy {
  Always,
  IfNotPresent
}

class ContainerDescription {
  constructor (public image: string, public cmd: Array<string>, public vars: Array<NameValuePair> = [], public imagePullPolicy?: ImagePullPolicy) {
  }
}

const DEFAULT_CONTAINERS = [
  new ContainerDescription(STENCILA_CORE_IMAGE, ['stencila-cmd'], [
    { name: 'STENCILA_AUTH', value: 'false' }
  ], ImagePullPolicy.IfNotPresent),
  new ContainerDescription('stencila/base-node', ['stencila-cmd'], [
    { name: 'STENCILA_AUTH', value: 'false' }
  ], ImagePullPolicy.Always),
  new ContainerDescription('alpine', ['sleep', '90'])
]

export const CONTAINER_MAP = new Map(DEFAULT_CONTAINERS.map(
    (containerDescription: ContainerDescription): [string, ContainerDescription] =>
        [containerDescription.image, containerDescription]
))

interface PodLabels {
  type: string
  reason: string
}

interface PodRequestMetadata {
  name: string
  type: string
  labels: PodLabels
}

interface ContainerResourceDefinition {
  memory: string
  cpu: string
}

interface ContainerResources {
  requests: ContainerResourceDefinition
  limits: ContainerResourceDefinition
}

interface ContainerPortDefinition {
  containerPort: number
}

interface ContainerDefinition {
  name: string
  image: string
  imagePullPolicy: string
  env: Array<NameValuePair>
  command: Array<string>
  args: Array<string>
  resources: ContainerResources
  ports: Array<ContainerPortDefinition>
}

interface PodSecurityContext {
  runAsUser: number
}

interface MatchExpression {
  key: string
  operator: string
  values: Array<string>
}

interface LabelSelector {
  matchExpressions: Array<MatchExpression>
}

interface PodAffinityTerm {
  labelSelector: LabelSelector
  topologyKey: string
}

interface PreferredDuringSchedulingIgnoredDuringExecutionDefinition {
  weight: number
  podAffinityTerm: PodAffinityTerm
}

interface PodAffinity {
  preferredDuringSchedulingIgnoredDuringExecution: Array<PreferredDuringSchedulingIgnoredDuringExecutionDefinition>
}

interface PodAffinityWrapper {
  podAffinity: PodAffinity
}

interface PodRequestSpec {
  containers: Array<ContainerDefinition>
  restartPolicy: string
  securityContext: PodSecurityContext
  automountServiceAccountToken: boolean
  affinity?: PodAffinityWrapper
}

interface PodRequest {
  kind: string
  apiVersion: string
  metadata: PodRequestMetadata
  spec: PodRequestSpec
}

interface SessionProxyRequestOptions {
  method: string
  uri: string
  headers: object
  body?: any
}

function softwareSessionToResourceLimitsTransformer (session: SoftwareSession): ContainerResources {
  let memoryRequested: number

  if (session.ram && session.ram.reservation) {
    memoryRequested = session.ram.reservation
  } else {
    memoryRequested = POD_REQUEST_MEM
  }

  let memoryLimit: number

  if (session.ram && session.ram.limit) {
    memoryLimit = session.ram.limit
  } else {
    memoryLimit = POD_LIMIT_MEM
  }

  let cpuLimit: number

  if (session.cpu && session.cpu.shares) {
    cpuLimit = (session.cpu.shares / 1024) * 1000
  } else {
    cpuLimit = POD_LIMIT_CPU
  }

  return {
    requests: {
      memory: `${memoryRequested}Gi`,
      cpu: `${POD_REQUEST_CPU}m`
    },
    limits: {
      memory: `${memoryLimit}Gi`,
      cpu: `${cpuLimit}m`
    }
  }
}

export interface ICluster {
  spawn (session: SoftwareSession, reason: string): Promise<string>
}

export class KubernetesCluster implements ICluster {
  private _k8s: KubernetesClient.ApiRoot
  private _options: KubernetesClusterOptions
  private _list?: Map<string, SessionDescription>
  private _listCachedAt?: Date
  private _pods?: ApiV1NamespacesNamePods
  private readonly _containers: Map<string, ContainerDescription>

  constructor () {
    let config
    if (process.env.NODE_ENV === 'development') {
      config = kubernetesConfig.fromKubeconfig()
      if (!(config.url.startsWith('https://10.') || config.url.startsWith('https://192.168.') || config.url.startsWith('https://172.'))) {
        throw new Error('It looks like you are trying to connect to a remote Kubernetes cluster while in development. Maybe you forgot to `minikube start`?')
      }
    } else {
      config = kubernetesConfig.getInCluster()
    }
    pino.info({ subject: 'config', url: config.url })

    this._k8s = new KubernetesClient({ config })

    this._options = {
      listRefresh: 10000 // milliseconds
    }

    this._containers = CONTAINER_MAP
  }

  async init () {
    if (this._pods) {
      return
    }
    this._pods = this._k8s.api.v1.namespaces('default').pods
  }

  async list (): Promise<Map<string, SessionDescription>> {
    if (!this._listCachedAt || (new Date().getTime() - this._listCachedAt.getTime()) > this._options.listRefresh) {
      if (!this._pods) {
        throw new TypeError('this._pods has not been instantiated.')
      }

      const response = await this._pods.get({
        qs: {
          labelSelector: 'type=session'
        }
      })

      const pods = response.body
      const podItems = pods.items as Array<PodDescription>
      let sessions: Array<SessionDescription> = podItems.map(pod => KubernetesCluster._podToSession(pod))
      sessions.sort((a, b) => a.created - b.created)
      let pendingQueue = 0
      sessions = sessions.map(session => {
        if (session.status === 'pending') {
          session.pendingPosition = pendingQueue
          pendingQueue += 1
        }
        return session
      })

      this._list = new Map(sessions.map((session: SessionDescription): [string, SessionDescription] =>
          [session.id, session]
      ))

      this._listCachedAt = new Date()
    }

    if (!this._list) {
      return new Map()
    }

    return this._list
  }

  async get (sessionId: string): Promise<SessionDescription> {
    const sessions = await this.list()

    if (sessions && sessions.has(sessionId)) {
      // @ts-ignore Typescript does not understand that the .has() check means undefined is not returned
      return sessions.get(sessionId)
    } else {
      if (!this._pods) {
        throw new TypeError('this._pods has not been instantiated')
      }

      const requested = await this._pods(sessionId).get()
      const pod = requested.body
      return KubernetesCluster._podToSession(pod)
    }
  }

  /**
   * Spawn a new pod in the cluster
   */
  async spawn (session: SoftwareSession, reason: string): Promise<string> {
    if (!this._pods) {
      throw new TypeError('this._pods has not been instantiated')
    }

    const time = new Date().toISOString().replace(/[-T:.Z]/g, '')
    const rand = crypto.randomBytes(16).toString('hex')
    const name = `session-${time}-${rand}`
    const port = DEFAULT_PORT
    const labels: PodLabels = {
      type: 'session',
      reason: reason
    }

    const environId = session.environment.id

    const container = this._containers.get(environId)

    if (!container) {
      throw new TypeError('Container with environment ID ' + environId + ' does not exist.')
    }

    let resources = softwareSessionToResourceLimitsTransformer(session)

    const options: PodRequest = {
      kind: 'Pod',
      apiVersion: 'v1',
      metadata: {
        name: name,
        type: 'stencila-cloud-pod',
        labels: labels
      },
      spec: {
        containers: [{
          name: 'stencila-host-container',

          image: container.image,
          imagePullPolicy: ImagePullPolicy[container.imagePullPolicy || ImagePullPolicy.IfNotPresent],

          env: container.vars,

          command: container.cmd.slice(0, 1),
          args: container.cmd.slice(1),

          resources: resources,

          ports: [{
            containerPort: port
          }]
        }],
        restartPolicy: 'Never',
        securityContext: {
          runAsUser: 1000
        },
        // Do NOT mount any K8s service account tokens into the pod so
        // that session containers can not access the K8s API
        automountServiceAccountToken: false
      }
    }

    // Apply session affinity option
    if (SESSION_AFFINITY) {
      options.spec['affinity'] = {
        podAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: SESSION_AFFINITY,
            podAffinityTerm: {
              labelSelector: {
                matchExpressions: [{
                  key: 'type',
                  operator: 'In',
                  values: ['session']
                }]
              },
              topologyKey: 'kubernetes.io/hostname'
            }
          }]
        }
      }
    }

    const response = await this._pods.post({ body: options })
    const pod = response.body
    pino.info({ subject: 'created', pod: pod.metadata.name, port: port })

    return pod.metadata.name
  }

  /**
   * Transform a Kubernetes pod description into
   * a session description
   *
   * @param  {PodDescription} pod Kubernetes pod description
   * @return {SessionDescription}     Session description
   */
  static _podToSession (pod: PodDescription): SessionDescription {
    return new SessionDescription(
        pod.metadata.name,
        pod.status.podIP,
        DEFAULT_PORT,
        pod.metadata.creationTimestamp,
        pod.status.phase.toLowerCase()
    )
  }

  async resolve (sessionId: string): Promise<string> {
    const pod = await this.get(sessionId)
    if (pod.ip && pod.port) {
      return `http://${pod.ip}:${pod.port}`
    } else if (pod.status === 'Pending') {
      throw new Error('Pod not ready yet')
    } else {
      throw new Error('Pod failure?')
    }
  }

  async sessionProxy (sessionId: string, method: string, path: string, body?: Buffer): Promise<object> {
    const podUrl = await this.resolve(sessionId)
    const uri = podUrl + path
    const options: SessionProxyRequestOptions = {
      method,
      uri,
      headers: {
        Accept: 'application/json'
      }
    }
    if (body && body.length && (method === 'POST' || method === 'PUT')) {
      options.body = body.toString()
    }
    return new Promise((resolve, reject) => {
      request(options, { retries: 1 }, (err: Promise<any>, res: any, body: any) => {
        console.log(body)
        if (err) reject(err)
        resolve(body)
      })
    })
  }
}
