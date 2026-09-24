import { APP_INTERCEPTOR } from '@nestjs/core'
import { AppLogger } from './app-logger.service'
import { LOGGER_OPTIONS } from './logging.constants'
import { LoggingModule } from './logging.module'
import { GrpcAccessLogInterceptor } from './interceptors'

type Provider = { provide?: unknown }

describe('LoggingModule', () => {
  it('registers the global gRPC interceptor once while forRoot only supplies options', () => {
    const baseProviders = Reflect.getMetadata('providers', LoggingModule) as Array<
      Provider | unknown
    >
    const configured = LoggingModule.forRoot({ serviceName: 'fixture-service' })

    expect(baseProviders).toEqual(
      expect.arrayContaining([
        AppLogger,
        GrpcAccessLogInterceptor,
        expect.objectContaining({ provide: APP_INTERCEPTOR })
      ])
    )
    expect(configured.providers).toEqual([
      { provide: LOGGER_OPTIONS, useValue: { serviceName: 'fixture-service' } }
    ])
  })
})
