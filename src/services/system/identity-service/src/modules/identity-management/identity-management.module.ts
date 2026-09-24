import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { ValidatingCommandBus, ValidatingQueryBus } from '@oes/common/cqrs'
import { CheckResourceService } from '../../application/authorization'
import { HR_EMPLOYEE_REFERENCE_PORT } from '../../application/ports/hr-employee-reference.port'
import { PARTY_REGISTRATION_PORT } from '../../application/ports/party-registration.port'
import { TENANT_REFERENCE_PORT } from '../../application/ports/tenant-reference.port'
import {
  AccountCommandHandlers,
  ContactCommandHandlers,
  EmployeeBindingCommandHandlers,
  ServiceAccountCommandHandlers
} from '../../application/commands'
import {
  ACCOUNT_DELETION_BLOCKER_CHECKERS,
  AccountDeletionBlockerService
} from '../../application/services/account-deletion-blocker.service'
import { SYMBOLS } from '../../common/constants'
import { PrismaAccountContactAssetRepository } from '../../infrastructure/repositories/prisma/prisma.account-contact-asset.repository'
import { PrismaApiKeyRepository } from '../../infrastructure/repositories/prisma/prisma.api-key.repository'
import { PrismaAccountRepository } from '../../infrastructure/repositories/prisma/prisma.account.repository'
import { PrismaEmployeeBindingRepository } from '../../infrastructure/repositories/prisma/prisma.employee-binding.repository'
import { PrismaServiceAccountRepository } from '../../infrastructure/repositories/prisma/prisma.service-account.repository'
import { PrismaMachineWorkloadBindingRepository } from '../../infrastructure/repositories/prisma/prisma.machine-workload-binding.repository'
import { PrismaUserRepository } from '../../infrastructure/repositories/prisma/prisma.user.repository'
import { HrEmployeeReferenceGrpcAdaptor } from '../../infrastructure/adaptors/hr-employee-reference.grpc.adaptor'
import { PartyRegistrationGrpcAdaptor } from '../../infrastructure/adaptors/party-registration.grpc.adaptor'
import { IdentityPartyTrustedGrpcClient } from '../../infrastructure/adaptors/party-trusted-grpc.client'
import { IdentityPartyMachineSourceCredentialClient } from '../../infrastructure/adaptors/identity-party-machine-source-credential.client'
import { IdentityPartyMachineSourceCredentialProvider } from '../../infrastructure/adaptors/identity-party-machine-source-credential.provider'
import { IdentityPartyExecutionTokenExchangeClient } from '../../infrastructure/adaptors/identity-party-execution-token-exchange.client'
import { IdentityPartyTrustedGrpcExecutionProducer } from '../../infrastructure/adaptors/identity-party-trusted-grpc-execution.producer'
import { IdentityTrustedExecutionModule } from '../identity-trusted-execution.module'
import { TenantReferenceGrpcAdaptor } from '../../infrastructure/adaptors/tenant-reference.grpc.adaptor'
import { PrismaModule } from '../../infrastructure/prisma/prisma.module'
import { IdentityManagementGrpcController } from '../../interfaces/grpc/identity-management.grpc.controller'
import { IdentityAuditModule } from '../identity-audit/identity-audit.module'

@Module({
  imports: [CqrsModule, PrismaModule, IdentityAuditModule, IdentityTrustedExecutionModule],
  providers: [
    {
      provide: SYMBOLS.REPO.ACCOUNT,
      useClass: PrismaAccountRepository
    },
    {
      provide: SYMBOLS.REPO.USER,
      useClass: PrismaUserRepository
    },
    {
      provide: SYMBOLS.REPO.ACCOUNT_CONTACT_ASSET,
      useClass: PrismaAccountContactAssetRepository
    },
    {
      provide: SYMBOLS.REPO.EMPLOYEE_BINDING,
      useClass: PrismaEmployeeBindingRepository
    },
    {
      provide: SYMBOLS.REPO.API_KEY,
      useClass: PrismaApiKeyRepository
    },
    {
      provide: SYMBOLS.REPO.SERVICE_ACCOUNT,
      useClass: PrismaServiceAccountRepository
    },
    {
      provide: SYMBOLS.REPO.MACHINE_WORKLOAD_BINDING,
      useClass: PrismaMachineWorkloadBindingRepository
    },
    {
      provide: PARTY_REGISTRATION_PORT,
      useClass: PartyRegistrationGrpcAdaptor
    },
    {
      provide: TENANT_REFERENCE_PORT,
      useClass: TenantReferenceGrpcAdaptor
    },
    {
      provide: HR_EMPLOYEE_REFERENCE_PORT,
      useClass: HrEmployeeReferenceGrpcAdaptor
    },
    ValidatingCommandBus,
    ValidatingQueryBus,
    CheckResourceService,
    AccountDeletionBlockerService,
    {
      provide: ACCOUNT_DELETION_BLOCKER_CHECKERS,
      useValue: []
    },
    ...AccountCommandHandlers,
    ...EmployeeBindingCommandHandlers,
    ...ContactCommandHandlers,
    ...ServiceAccountCommandHandlers
  ],
  controllers: [IdentityManagementGrpcController]
})
export class IdentityManagementModule {}
