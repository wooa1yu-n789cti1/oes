import { Metadata } from '@grpc/grpc-js'
import { getGrpcAuthorizationBearer, getGrpcMetadataValue } from '@oes/common/authorization'
import type { ExecutionTokenExchangeContextPort } from '../../application/ports/execution-token-exchange-context.port'
import type {
  ExchangeExecutionTokenInput,
  ExecutionTokenAuthorizationDecision,
  TrustedExecutionContext,
  VerifiedExecutionWorkload
} from '../../application/services/execution-token-exchange.service'

type VerifiedWorkloadResolver = {
  getVerifiedWorkloadIdentity(call: unknown): Promise<VerifiedExecutionWorkload>
}

/** Verifies the carrier bearer with its owning Auth credential truth and returns no authorization set. */
export interface ExecutionTokenSourceCredentialVerifier {
  verify(
    sourceCredential: string,
    workloadIdentity: VerifiedExecutionWorkload,
    request?: Pick<ExchangeExecutionTokenInput, 'targetAudience' | 'requestedPermissionCodes'> & {
      requestId?: string
      traceparent?: string
      tracestate?: string
    }
  ): Promise<TrustedExecutionContext>
}

/** Resolves Permission's independently granted upper bound for one verified principal request. */
export interface ExecutionTokenPermissionDecisionResolver {
  resolve(input: {
    request: Pick<ExchangeExecutionTokenInput, 'targetAudience' | 'requestedPermissionCodes'>
    workloadIdentity: VerifiedExecutionWorkload
    execution: TrustedExecutionContext
    requestId?: string
    traceparent?: string
    tracestate?: string
  }): Promise<ExecutionTokenAuthorizationDecision>
}

/** Resolves STS input only from the carrier bearer, Auth-owned credential verification, Permission, and mTLS. */
export class VerifiedExecutionTokenContextProvider implements ExecutionTokenExchangeContextPort {
  constructor(
    private readonly workloadResolver: VerifiedWorkloadResolver,
    private readonly sourceCredentialVerifier: ExecutionTokenSourceCredentialVerifier,
    private readonly permissionDecisionResolver: ExecutionTokenPermissionDecisionResolver
  ) {}

  /** Produces request-bound execution and authorization facts without consulting DTO or legacy operator fields. */
  async resolve(
    call: unknown,
    request: Pick<ExchangeExecutionTokenInput, 'targetAudience' | 'requestedPermissionCodes'>
  ): Promise<Omit<ExchangeExecutionTokenInput, 'targetAudience' | 'requestedPermissionCodes'>> {
    const workloadIdentity = await this.workloadResolver.getVerifiedWorkloadIdentity(call)
    const metadata = readCallMetadata(call)
    const sourceCredential = getGrpcAuthorizationBearer(metadata)
    if (!sourceCredential) throw new Error('verified source credential is required')

    const correlation = {
      ...optionalMetadata(metadata, 'x-request-id', 'requestId'),
      ...optionalMetadata(metadata, 'traceparent', 'traceparent'),
      ...optionalMetadata(metadata, 'tracestate', 'tracestate')
    }
    const execution = Object.freeze({
      ...(await this.sourceCredentialVerifier.verify(sourceCredential, workloadIdentity, {
        ...request,
        ...correlation
      }))
    })
    const authorizationDecision = Object.freeze(
      await this.permissionDecisionResolver.resolve({
        request,
        workloadIdentity,
        execution,
        ...correlation
      })
    )
    return Object.freeze({ workloadIdentity, execution, authorizationDecision })
  }
}

/** Reads only the grpc-js call metadata that the current private carrier writes. */
function readCallMetadata(call: unknown): Metadata {
  if (!call || typeof call !== 'object') throw new Error('gRPC exchange call is required')
  const metadata = (call as { metadata?: unknown }).metadata
  if (!(metadata instanceof Metadata)) throw new Error('gRPC exchange metadata is required')
  return metadata
}

/** Copies one correlation value without promoting ordinary metadata into authorization authority. */
function optionalMetadata(
  metadata: Metadata,
  metadataKey: string,
  propertyName: string
): Record<string, string> {
  const value = getGrpcMetadataValue(metadata, metadataKey)
  if (propertyName === 'tracestate' && value === '') return {}
  return value === undefined ? {} : { [propertyName]: value }
}
