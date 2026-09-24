// File: src/common/src/logging/logging.module.ts

import { Global, Module, DynamicModule } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { AppLogger } from './app-logger.service'
import { PinoOtelLoggerOptions } from './pino-otel.logger'
import { LOGGER_OPTIONS } from './logging.constants'
import { GrpcAccessLogInterceptor } from './interceptors'

@Global()
@Module({
  providers: [
    AppLogger,
    GrpcAccessLogInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useExisting: GrpcAccessLogInterceptor
    }
  ],
  exports: [AppLogger, GrpcAccessLogInterceptor]
})
export class LoggingModule {
  /**
   * Configure the logging module with custom options.
   *
   * @param options - Logger configuration options
   * @returns Dynamic module with configured AppLogger
   */
  static forRoot(options: Partial<PinoOtelLoggerOptions>): DynamicModule {
    return {
      module: LoggingModule,
      providers: [
        {
          provide: LOGGER_OPTIONS,
          useValue: options
        }
      ],
      exports: [AppLogger, GrpcAccessLogInterceptor]
    }
  }
}
