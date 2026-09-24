import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { ValidatingQueryBus } from '@oes/common/cqrs'
import { GetCrmAccountHandler } from '../application/queries/get-crm-account.handler'
import { ListCrmAccountsHandler } from '../application/queries/list-crm-accounts.handler'
import { ListSourceRecordsHandler } from '../application/queries/list-source-records.handler'
import { ValidateCrmObjectReferenceHandler } from '../application/queries/validate-object-reference.handler'
import { CrmObjectReferenceGrpcController } from '../interfaces/grpc/crm-object-reference.grpc.controller'
import { CustomerQueryGrpcController } from '../interfaces/grpc/customer-query.grpc.controller'
import { CrmTrustedExecutionModule } from './crm-trusted-execution.module'

/** CrmQueryModule wires the phase 1 CRM query handlers and gRPC controller surface. */
@Module({
  imports: [CqrsModule, CrmTrustedExecutionModule],
  providers: [
    ValidatingQueryBus,
    GetCrmAccountHandler,
    ListCrmAccountsHandler,
    ListSourceRecordsHandler,
    ValidateCrmObjectReferenceHandler
  ],
  controllers: [CustomerQueryGrpcController, CrmObjectReferenceGrpcController]
})
export class CrmQueryModule {}
