const pino = require('pino')()

// Configuration settings
// const POD_TIMEOUT = process.env.POD_TIMEOUT || 3600 // seconds
const STANDBY_POOL = process.env.STANDBY_POOL || 10 // target number of containers in the standby pool
const STANDBY_FREQ = process.env.STANDBY_FREQ || 30000 // fill the standby pool every x milliseconds

const FILL_FREQ = process.env.FILL_FREQ || 15000 // Time in ms
const CLEAN_FREQ = process.env.CLEAN_FREQ || 15000 // Time in ms

const STENCILA_CORE_IMAGE = process.env.STENCILA_CORE_IMAGE || 'stencila/core'

class Cluster {
  constructor (options = {}) {
    // A map between environment ids and container options
    this.containers = {
      'stencila/core': {
        image: STENCILA_CORE_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        vars: [{
          name: 'STENCILA_AUTH',
          value: 'false'
        }],
        cmd: ['stencila-cmd']
      },
      'stencila/base-node': {
        image: 'stencila/base-node',
        imagePullPolicy: 'Always',
        vars: [{
          name: 'STENCILA_AUTH',
          value: 'false'
        }],
        cmd: ['stencila-cmd']
      },
      'alpine': {
        image: 'alpine',
        vars: [],
        cmd: ['sleep', '90']
      },
      'stencila/examples-elife-30274': {
        image: 'stencila/examples-elife-30274',
        imagePullPolicy: 'Always'
      },
    }
  }

  async start () {
    // Start the cluster fill and clean tasks
    await this.init()
    setInterval(() => this.fill(), FILL_FREQ)
    setInterval(() => this.clean(), CLEAN_FREQ)
  }

  async init () {

  }

  /**
   * List the pods in the cluster
   */
  async list () {
    throw new Error('Not implemented: must be overidden')
  }

  async get (podId) {
    const pods = await this.list()
    if (pods.has(podId)) return pods.get(podId)
    else return null
  }

  async resolve (podId) {
    const pod = await this.get(podId)
    if (pod.ip && pod.port) {
      return `http://${pod.ip}:${pod.port}`
    } else if (pod.status === 'Pending') {
      throw new Error('Pod not ready yet')
    } else {
      throw new Error('Pod failiure?')
    }
  }

  /**
   * Spawn a new pod
   */
  async spawn (environId, pool, reason) {
    throw new Error('Not implemented: must be overidden')
  }

  /**
   * Acquire a pod from the cluster
   */
  async acquire (environId) {
    throw new Error('Not implemented: must be overidden')
  }

  /**
   * Fill standby pools to the desired number of pods
   */
  async fill () {
    try {
      const pods = await this.list()
      pino.info({ subject: 'filling', desired: STANDBY_POOL, actual: pods.size })
      const required = STANDBY_POOL - pods.size
      for (let index = 0; index < required; index++) {
        this.spawn(null, 'standby', 'filling')
      }
    } catch (err) {
      pino.error({ subject: 'filling', msg: err.message })
    }
    setTimeout(() => this.fill(), STANDBY_FREQ)
  }

  /**
   * Clean the cluster by removing pods that have terminated
   */
  async clean () {
    throw new Error('Not implemented: must be overidden')
  }
}

module.exports = Cluster
