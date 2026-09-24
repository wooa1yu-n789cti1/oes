import { CreateApiKeyHandler } from './create-api-key.handler'
import { CreateServiceAccountHandler } from './create-service-account.handler'
import { RevokeApiKeyHandler } from './revoke-api-key.handler'
import { RotateApiKeyHandler } from './rotate-api-key.handler'
import { SetServiceAccountEnabledHandler } from './set-service-account-enabled.handler'
import { EnrollMachineWorkloadBindingHandler } from './enroll-machine-workload-binding.handler'
import { DisableMachineWorkloadBindingHandler } from './disable-machine-workload-binding.handler'

export * from './authenticate-api-key.command'
export * from './create-api-key.command'
export * from './create-service-account.command'
export * from './revoke-api-key.command'
export * from './rotate-api-key.command'
export * from './set-service-account-enabled.command'
export * from './enroll-machine-workload-binding.command'
export * from './disable-machine-workload-binding.command'
export * from './authenticate-api-key.handler'
export * from './create-api-key.handler'
export * from './enroll-machine-workload-binding.handler'
export * from './disable-machine-workload-binding.handler'

export const ServiceAccountCommandHandlers = [
  CreateApiKeyHandler,
  CreateServiceAccountHandler,
  RevokeApiKeyHandler,
  RotateApiKeyHandler,
  SetServiceAccountEnabledHandler,
  EnrollMachineWorkloadBindingHandler,
  DisableMachineWorkloadBindingHandler
]
