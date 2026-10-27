import { pathToFileURL } from 'node:url'

import type { FastifyInstance } from 'fastify'

import { createProductionApp, type ProductionAppDependencies } from './app.ts'
import { parseRuntimeConfig, type RuntimeConfig } from './config/runtime-config.ts'

export interface StartServerDependencies extends ProductionAppDependencies {
  createApp?: (config: RuntimeConfig, dependencies: ProductionAppDependencies) => Promise<FastifyInstance>
}

export interface RunningServer {
  app: FastifyInstance
  shutdown: () => Promise<void>
}

export async function startProductionServer(
  config: RuntimeConfig,
  dependencies: StartServerDependencies = {},
): Promise<RunningServer> {
  const { createApp = createProductionApp, ...appDependencies } = dependencies
  const app = await createApp(config, appDependencies)
  try {
    await app.listen({ host: config.host, port: config.port })
  } catch {
    await app.close().catch(() => undefined)
    throw new Error('Server startup failed')
  }
  let stopping: Promise<void> | undefined
  const shutdown = async (): Promise<void> => {
    stopping ??= app.close()
    await stopping
  }
  return { app, shutdown }
}

async function main(): Promise<void> {
  try {
    const config = parseRuntimeConfig(process.env)
    const server = await startProductionServer(config)
    const stop = (): void => {
      void server.shutdown().then(
        () => { process.exitCode = 0 },
        () => { process.exitCode = 1 },
      )
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch {
    console.error('Server startup failed')
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main()
}
