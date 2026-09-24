import { Global, Module } from '@nestjs/common'
import {
  AsyncLocalTransportPrivateSourceCredentialAccessor,
  AsyncLocalTrustedExecutionContextAccessor,
  CertificateBoundExecutionTokenCache,
  TrustedExecutionRegistry,
  TrustedGrpcMetadataProvider
} from '@oes/common/authorization'
import { readLocalVerifiedWorkloadIdentity } from '@oes/common/transport'
import { GatewayAssetGrpcClient } from './gateway-asset-grpc.client'
import { GatewayBrowserActivityGrpcClient } from './gateway-browser-activity-grpc.client'
import { GatewayTerminalDeviceGrpcClient } from './gateway-terminal-device-grpc.client'
import { GatewayFinanceGrpcClient } from './gateway-finance-grpc.client'
import { GatewaySalesGrpcClient } from './gateway-sales-grpc.client'
import { GatewayAuthExecutionTokenExchangeClient } from './gateway-auth-execution-token-exchange.client'
import { GatewayTrustedGrpcExecutionProducer } from './gateway-trusted-grpc-execution-producer'
import { GatewayAuthMachineWorkloadSourceCredentialClient } from './gateway-auth-machine-workload-source-credential.client'
import { GatewayMachineWorkloadSourceCredentialProvider } from './gateway-machine-workload-source-credential.provider'
import { GatewayMachineTrustedGrpcExecutionProducer } from './gateway-machine-trusted-grpc-execution-producer'
import { GatewayPublicEntryGrpcClient } from './gateway-public-entry-grpc.client'
import { GatewayMesGrpcClient } from './gateway-mes-grpc.client'
import { GatewayCollaborationGrpcClient } from './gateway-collaboration-grpc.client'
import { GatewayItemMasterGrpcClient } from './gateway-item-master-grpc.client'
import { GatewaySrmGrpcClient, SRM_TARGET_AUDIENCE } from './gateway-srm-grpc.client'
import {
  GatewayProcurementGrpcClient,
  PROCUREMENT_TARGET_AUDIENCE
} from './gateway-procurement-grpc.client'
import { GatewayWmsGrpcClient, WMS_TARGET_AUDIENCE } from './gateway-wms-grpc.client'
import { GatewayCrmGrpcClient, CRM_TARGET_AUDIENCE } from './gateway-crm-grpc.client'

const ASSET_AUDIENCE = 'urn:oes:service:asset-service'
const SITE_AUDIENCE = 'urn:oes:service:site-service'
const BROWSER_ACTIVITY_AUDIENCE = 'urn:oes:service:browser-activity-service'
const TERMINAL_DEVICE_AUDIENCE = 'urn:oes:service:terminal-device-service'
const FINANCE_AUDIENCE = 'urn:oes:service:finance-service'
const SALES_AUDIENCE = 'urn:oes:service:sales-service'
const PUBLIC_ENTRY_AUDIENCE = 'urn:oes:service:public-entry-service'
const MES_AUDIENCE = 'urn:oes:service:mes-service'
const COLLABORATION_AUDIENCE = 'urn:oes:service:collaboration-service'
const ITEM_MASTER_AUDIENCE = 'urn:oes:service:item-master-service'
const PARTY_AUDIENCE = 'urn:oes:service:party-service'

/** Composes the sole Gateway target-token producer with the same request-private source-credential accessor. */
@Global()
@Module({
  providers: [
    AsyncLocalTransportPrivateSourceCredentialAccessor,
    AsyncLocalTrustedExecutionContextAccessor,
    GatewayAssetGrpcClient,
    GatewayBrowserActivityGrpcClient,
    GatewayTerminalDeviceGrpcClient,
    GatewayFinanceGrpcClient,
    GatewaySalesGrpcClient,
    GatewayPublicEntryGrpcClient,
    GatewayMesGrpcClient,
    GatewayCollaborationGrpcClient,
    GatewayItemMasterGrpcClient,
    GatewaySrmGrpcClient,
    GatewayProcurementGrpcClient,
    GatewayWmsGrpcClient,
    GatewayCrmGrpcClient,
    GatewayAuthMachineWorkloadSourceCredentialClient,
    {
      provide: GatewayMachineWorkloadSourceCredentialProvider,
      useFactory: (
        client: GatewayAuthMachineWorkloadSourceCredentialClient,
        accessor: AsyncLocalTransportPrivateSourceCredentialAccessor
      ) => new GatewayMachineWorkloadSourceCredentialProvider(client, undefined, accessor),
      inject: [
        GatewayAuthMachineWorkloadSourceCredentialClient,
        AsyncLocalTransportPrivateSourceCredentialAccessor
      ]
    },
    {
      provide: GatewayAuthExecutionTokenExchangeClient,
      useFactory: (context: AsyncLocalTrustedExecutionContextAccessor) =>
        new GatewayAuthExecutionTokenExchangeClient(context),
      inject: [AsyncLocalTrustedExecutionContextAccessor]
    },
    {
      provide: TrustedExecutionRegistry,
      useFactory: () =>
        new TrustedExecutionRegistry({
          issuer: requireEnvironment('AUTH_EXECUTION_ISSUER'),
          audiences: [
            ASSET_AUDIENCE,
            SITE_AUDIENCE,
            BROWSER_ACTIVITY_AUDIENCE,
            TERMINAL_DEVICE_AUDIENCE,
            FINANCE_AUDIENCE,
            SALES_AUDIENCE,
            PUBLIC_ENTRY_AUDIENCE,
            MES_AUDIENCE,
            COLLABORATION_AUDIENCE,
            ITEM_MASTER_AUDIENCE,
            PARTY_AUDIENCE,
            SRM_TARGET_AUDIENCE,
            PROCUREMENT_TARGET_AUDIENCE,
            WMS_TARGET_AUDIENCE,
            CRM_TARGET_AUDIENCE
          ],
          workloadIdentities: [requireEnvironment('OES_WORKLOAD_SPIFFE_ID')]
        })
    },
    {
      provide: CertificateBoundExecutionTokenCache,
      useFactory: () => new CertificateBoundExecutionTokenCache({ refreshMarginSeconds: 30 })
    },
    {
      provide: TrustedGrpcMetadataProvider,
      useFactory: (
        contextAccessor: AsyncLocalTrustedExecutionContextAccessor,
        registry: TrustedExecutionRegistry,
        tokenCache: CertificateBoundExecutionTokenCache,
        exchangeClient: GatewayAuthExecutionTokenExchangeClient,
        sourceCredentialAccessor: AsyncLocalTransportPrivateSourceCredentialAccessor
      ) =>
        new TrustedGrpcMetadataProvider({
          contextAccessor,
          registry,
          tokenCache,
          exchangeClient,
          sourceCredentialAccessor,
          localWorkloadIdentity: {
            getVerifiedWorkloadIdentity: async () => readLocalVerifiedWorkloadIdentity()
          }
        }),
      inject: [
        AsyncLocalTrustedExecutionContextAccessor,
        TrustedExecutionRegistry,
        CertificateBoundExecutionTokenCache,
        GatewayAuthExecutionTokenExchangeClient,
        AsyncLocalTransportPrivateSourceCredentialAccessor
      ]
    },
    {
      provide: GatewayTrustedGrpcExecutionProducer,
      useFactory: (
        context: AsyncLocalTrustedExecutionContextAccessor,
        metadata: TrustedGrpcMetadataProvider
      ) => new GatewayTrustedGrpcExecutionProducer(context, metadata),
      inject: [AsyncLocalTrustedExecutionContextAccessor, TrustedGrpcMetadataProvider]
    },
    {
      provide: GatewayMachineTrustedGrpcExecutionProducer,
      useFactory: (
        source: GatewayMachineWorkloadSourceCredentialProvider,
        metadata: TrustedGrpcMetadataProvider,
        context: AsyncLocalTrustedExecutionContextAccessor
      ) => new GatewayMachineTrustedGrpcExecutionProducer(source, metadata, context),
      inject: [
        GatewayMachineWorkloadSourceCredentialProvider,
        TrustedGrpcMetadataProvider,
        AsyncLocalTrustedExecutionContextAccessor
      ]
    }
  ],
  exports: [
    AsyncLocalTransportPrivateSourceCredentialAccessor,
    GatewayAssetGrpcClient,
    GatewayBrowserActivityGrpcClient,
    GatewayTerminalDeviceGrpcClient,
    GatewayFinanceGrpcClient,
    GatewaySalesGrpcClient,
    GatewayPublicEntryGrpcClient,
    GatewayMesGrpcClient,
    GatewayCollaborationGrpcClient,
    GatewayItemMasterGrpcClient,
    GatewaySrmGrpcClient,
    GatewayProcurementGrpcClient,
    GatewayWmsGrpcClient,
    GatewayCrmGrpcClient,
    GatewayTrustedGrpcExecutionProducer,
    GatewayMachineWorkloadSourceCredentialProvider,
    GatewayMachineTrustedGrpcExecutionProducer
  ]
})
export class GatewayTrustedGrpcExecutionModule {}

/** Requires deployment-owned STS registry facts and never creates synthetic authority. */
function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
