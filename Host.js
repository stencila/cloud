const crypto = require('crypto')
const Docker = require('dockerode')
const kubernetes = require('kubernetes-client')
const pino = require('pino')()
const randomPort = require('random-port')
const request = require('retry-request')

const version = require('./package.json').version
const HostHttpServer = require('./HostHttpServer')

// Configuration settings
const STENCILA_IMAGE = process.env.STENCILA_IMAGE || 'stencila/alpha'
const POD_TIMEOUT = 3600 // seconds

// During development, Docker is used to create session containers
const docker = new Docker({
  socketPath: '/var/run/docker.sock'
})

// In production, Kubernetes is used to create session containers
const k8s = new kubernetes.Core({
  url: 'http://127.0.0.1:8000'
})

/**
 * Implements the Stencila Host API using a Kubernetes cluster
 */
class Host {
  constructor () {
    this._id = `cloud-${crypto.randomBytes(24).toString('hex')}`
  }

  /**
   * Aquire a pod from the standby pool
   */
  aquire (cb) {
    if (process.env.NODE_ENV === 'development') {
      // During development, get a running container with label `pool=standby`
      // Launch these manually:
      //   docker run --label pool=standby -d -p 2010:2000 stencila/alpha
      // At time of writing it was not possible to update the label (e.g. to
      // remove it from the pool https://github.com/moby/moby/issues/21721#issuecomment-299577702)
      // So you have to stop them manually as well.
      docker.listContainers({
        'limit': 1,
        'filters': '{"status": ["running"], "label": ["pool=standby"]}'
      }, function (err, containers) {
        if (err) return cb(err)

        if (containers.length === 0) cb(null, null)
        else {
          let container = containers[0]
          let port = container.Ports[0]
          pino.info({ pod: container.Id }, 'aquired')

          let url = `http://${port.IP}:${port.PublicPort}`
          cb(null, url)
        }
      })
    } else {
      // In production, get a running container with label `pool=standby`
      k8s.ns.pods.get({ qs: { labelSelector: 'pool=standby' } }, (err, pods) => {
        if (err) return cb(err)

        for (let pod of pods.items) {
          if (pod.status.phase === 'Running') {
            pino.info({ pod: pod.metadata.name }, 'claiming')

            // Claim this pod
            k8s.ns.pods(pod.metadata.name).patch({ body: {
              metadata: {
                labels: {
                  pool: 'claimed',
                  claimer: this._id
                }
              }
            }}, (err, pod) => {
              if (err) return cb(err)

              pino.info({ pod: pod.metadata.name }, 'aquiring')

              // Check that this host is the claimer of the pod
              const id = pod.metadata.labels.claimer
              if (id === this._id) {
                // This host is the claimer so aquire it
                k8s.ns.pods(pod.metadata.name).patch({ body: {
                  metadata: {
                    labels: {
                      pool: 'aquired',
                      aquirer: this._id
                    }
                  }
                }}, (err, pod) => {
                  if (err) return cb(err)

                  pino.info({ pod: pod.metadata.name }, 'aquired')

                  let url = `http://${pod.status.podIP}:2000`
                  cb(null, url)
                })
              } else {
                // Another host claimed this pod just after this
                // host, so leave it to them and try again
                this.aquire(cb)
              }
            })

            break
          }
        }
      })
    }
  }

  /**
   * Spawn a new pod
   *
   * This will only be used if no standy by pods are available
   */
  spawn (cb) {
    const cmd = ['node']
    const args = ['-e', `require("stencila-node").run("0.0.0.0", 2000, false, ${POD_TIMEOUT})`]

    if (process.env.NODE_ENV === 'development') {
      // During development use Docker to emulate a pod by running
      // a new container
      randomPort((port) => {
        const options = {
          Image: STENCILA_IMAGE,
          Cmd: cmd.concat(args),
          ExposedPorts: { '2000/tcp': {} },
          HostConfig: {
            PortBindings: {
              '2000/tcp': [{
                'HostIp': '127.0.0.1',
                'HostPort': port.toString()
              }]
            }
          }
        }
        docker.createContainer(options, (err, container) => {
          if (err) return cb(err)

          pino.info({
            pod: container.id,
            port: port
          }, 'created')
          container.start((err) => {
            if (err) return cb(err)

            pino.info({
              pod: container.id,
              port: port
            }, 'started')
            cb(null, `http://127.0.0.1:${port}`)
          })
        })
      })
    } else {
      // In production, use Kubernetes to create a new pod
      const name = 'stencila-cloud-pod-' + crypto.randomBytes(12).toString('hex')
      const port = 2000
      k8s.ns.pods.post({ body: {
        kind: 'Pod',
        apiVersion: 'v1',
        metadata: {
          name: name,
          type: 'stencila-cloud-pod',
          metadata: {
            labels: {
              pool: 'spawned',
              spawner: this._id
            }
          }
        },
        spec: {
          containers: [{
            name: 'stencila-container',

            image: STENCILA_IMAGE,
            imagePullPolicy: 'IfNotPresent',

            command: cmd,
            args: args,

            resources: {
              requests: {
                memory: '500Mi',
                cpu: '250m'
              },
              limits: {
                memory: '2Gi',
                cpu: '1000m'
              }
            },

            ports: [{
              containerPort: port
            }]
          }],
          restartPolicy: 'Never'
        }
      }}, (err, pod) => {
        if (err) return cb(err)

        pino.info({ pod: pod.metadata.name }, 'created')
        const awaitPod = function () {
          k8s.ns.pods(name).get((err, pod) => {
            if (err) return cb(err)

            if (pod.status.phase === 'Running') {
              pino.info({ pod: pod.metadata.name }, 'started')
              cb(null, `http://${pod.status.podIP}:${port}`)
            } else setTimeout(awaitPod, 300)
          })
        }
        awaitPod()
      })
    }
  }

  obtain (cb) {
    this.aquire((err, pod) => {
      if (err) return cb(err)
      if (pod) return cb(null, pod)

      this.spawn((err, pod) => {
        if (err) return cb(err)

        cb(null, pod)
      })
    })
  }

  manifest (session, cb) {
    if (!session) {
      // If no session then just return a manifest
      cb(null, {
        id: this._id,
        stencila: {
          package: 'cloud',
          version: version
        }
      })
    } else {
      // If a session then use it's existing pod,
      // or spawn a new one
      ((cb) => {
        if (session.pod) {
          return cb(null, session.pod)
        }
        this.obtain((err, pod) => {
          if (err) return cb(err)

          session.pod = pod
          cb(null, pod)
        })
      })((err, pod) => {
        if (err) return cb(err)

        request({
          method: 'GET',
          uri: pod,
          headers: {
            Accept: 'application/json'
          }
        }, {retries: 9}, (err, resp, body) => {
          cb(err, body, session)
        })
      })
    }
  }

  post (type, body, session, cb) {
    if (!session.pod) return cb(new Error('Session has not been initialised yet'))

    request({
      method: 'POST',
      uri: session.pod + '/' + type,
      headers: {
        Accept: 'application/json'
      },
      body: body
    }, {retries: 9}, (err, res, body) => {
      cb(err, body, session)
    })
  }

  put (address, method, body, session, cb) {
    if (!session.pod) return cb(new Error('Session has not been initialised yet'))

    request({
      method: 'PUT',
      uri: session.pod + '/' + address + '!' + method,
      headers: {
        Accept: 'application/json'
      },
      body: body
    }, (err, res, body) => {
      cb(err, body, session)
    })
  }

  run () {
    const server = new HostHttpServer(this)
    server.start()
  }
}

module.exports = Host
