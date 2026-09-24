import { Controller, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common'
import {
  AuthorizeBusinessRpc,
  AuthorizeInternalCall,
  getAuthenticatedGrpcRequestContext,
  GrpcRequestContextInterceptor
} from '@oes/common/authorization'
import { HrFoundationTrustedExecutionGuard } from '../../modules/hr-trusted-execution.module'
import { GrpcMethod } from '@nestjs/microservices'
import { GrpcExceptionFilter } from '@oes/common/filters'
import {
  EmployeeLifecycleStatus as ProtoEmployeeLifecycleStatus,
  EmploymentStatus as ProtoEmploymentStatus,
  GetActiveEmploymentRequest,
  GetActiveEmploymentResponse,
  GetEmployeeByIdRequest,
  GetEmployeeByIdResponse,
  GetEmployeeByTenantPartyIdRequest,
  GetEmployeeByTenantPartyIdResponse,
  GetLatestOnboardingAccessRequest,
  GetLatestOnboardingAccessResponse,
  HrQueryServiceController,
  HrQueryServiceControllerMethods,
  OnboardingAccessStatus as ProtoOnboardingAccessStatus,
  ListEmployeesRequest,
  ListEmployeesResponse,
  ListEmploymentsRequest,
  ListEmploymentsResponse,
  ResolveAuthLoginEmployeeRequest,
  ResolveAuthLoginEmployeeResponse,
  ResolvePublicBusinessCardEmployeeRequest,
  ResolvePublicBusinessCardEmployeeResponse
} from '@oes/common/generated/hr_service'
import { HrQueryService } from '../../application/services'
import { EmployeeLifecycleStatus, EmploymentStatus } from '../../domain/value-objects'
import { mapEmployee, mapEmployment } from './hr-management.grpc.controller'
import { AuthorizeHrPublicEntryOwnerFact } from '../../modules/hr-trusted-execution.module'

interface ResolveActiveEmployeeByCodeRequest {
  tenantId?: string
  employeeCode?: string
}

interface ResolveActiveEmployeeByCodeResponse {
  employee?: ReturnType<typeof mapEmployee>
  activeEmployment?: ReturnType<typeof mapEmployment>
}

/** HrQueryGrpcController exposes read-only HR Employee and Employment contracts over gRPC. */
@UseFilters(GrpcExceptionFilter)
@UseGuards(HrFoundationTrustedExecutionGuard)
@UseInterceptors(GrpcRequestContextInterceptor)
@Controller()
@HrQueryServiceControllerMethods()
export class HrQueryGrpcController implements HrQueryServiceController {
  constructor(private readonly hrQueryService: HrQueryService) {}

  @AuthorizeInternalCall({ all: ['hr.internal.auth_login_employee.resolve'] })
  async resolveAuthLoginEmployee(
    request: ResolveAuthLoginEmployeeRequest
  ): Promise<ResolveAuthLoginEmployeeResponse> {
    const result = await this.hrQueryService.resolveActiveEmployeeByCode({
      tenantId: request.tenantId ?? '',
      employeeCode: request.employeeCode ?? ''
    })
    if (
      result.employee.tenantId !== request.tenantId ||
      result.employee.lifecycleStatus !== EmployeeLifecycleStatus.ACTIVE ||
      result.activeEmployment.status !== EmploymentStatus.ACTIVE
    )
      return {}
    return {
      employeeId: result.employee.id,
      activeEmploymentId: result.activeEmployment.id
    }
  }

  @AuthorizeHrPublicEntryOwnerFact()
  @AuthorizeInternalCall({ all: ['hr.internal.public_business_card_employee.resolve'] })
  async resolvePublicBusinessCardEmployee(
    request: ResolvePublicBusinessCardEmployeeRequest
  ): Promise<ResolvePublicBusinessCardEmployeeResponse> {
    try {
      const result = await this.hrQueryService.resolvePublicBusinessCardEmployee({
        tenantId: request.tenantId ?? '',
        employeeId: request.employeeId ?? ''
      })
      if (!result.available) return { available: false, reasonCode: result.reasonCode }
      return {
        available: true,
        employeeId: result.employeeId,
        lifecycleStatus: ProtoEmployeeLifecycleStatus.EMPLOYEE_LIFECYCLE_STATUS_ACTIVE,
        activeEmploymentId: result.activeEmploymentId,
        orgUnitId: result.orgUnitId ?? '',
        positionName: result.positionName ?? '',
        officialPhotoUrl: result.officialPhotoUrl ?? '',
        reasonCode: ''
      }
    } catch {
      return { available: false, reasonCode: 'OWNER_FACT_UNAVAILABLE' }
    }
  }

  async getEmployeeById(request: GetEmployeeByIdRequest): Promise<GetEmployeeByIdResponse> {
    const employee = await this.hrQueryService.getEmployeeById(request.employeeId ?? '')
    return { employee: mapEmployee(employee) }
  }

  async getEmployeeByTenantPartyId(
    request: GetEmployeeByTenantPartyIdRequest
  ): Promise<GetEmployeeByTenantPartyIdResponse> {
    const employee = await this.hrQueryService.getEmployeeByTenantPartyId({
      tenantId: getTrustedHrTenantId(request),
      tenantPartyId: request.tenantPartyId ?? ''
    })
    return { employee: mapEmployee(employee) }
  }

  /** resolveActiveEmployeeByCode maps the HR active employee-code lookup to the gRPC response shape. */
  @GrpcMethod('HrQueryService', 'resolveActiveEmployeeByCode')
  async resolveActiveEmployeeByCode(
    request: ResolveActiveEmployeeByCodeRequest
  ): Promise<ResolveActiveEmployeeByCodeResponse> {
    const result = await this.hrQueryService.resolveActiveEmployeeByCode({
      tenantId: request.tenantId ?? '',
      employeeCode: request.employeeCode ?? ''
    })
    return {
      employee: mapEmployee(result.employee),
      activeEmployment: mapEmployment(result.activeEmployment)
    }
  }

  async listEmployees(request: ListEmployeesRequest): Promise<ListEmployeesResponse> {
    const result = await this.hrQueryService.listEmployees({
      tenantId: getTrustedHrTenantId(request),
      keyword: request.keyword ?? undefined,
      lifecycleStatus: mapProtoEmployeeLifecycleStatus(request.lifecycleStatus),
      page: request.page ?? 1,
      pageSize: request.pageSize ?? 20
    })

    return {
      items: result.items.map(mapEmployee),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total
    }
  }

  async getActiveEmployment(
    request: GetActiveEmploymentRequest
  ): Promise<GetActiveEmploymentResponse> {
    const employment = await this.hrQueryService.getActiveEmployment(request.employeeId ?? '')
    return { employment: mapEmployment(employment) }
  }

  async listEmployments(request: ListEmploymentsRequest): Promise<ListEmploymentsResponse> {
    const employments = await this.hrQueryService.listEmployments({
      employeeId: request.employeeId ?? '',
      status: mapProtoEmploymentStatus(request.status)
    })
    return { employments: employments.map(mapEmployment) }
  }

  async getLatestOnboardingAccess(
    request: GetLatestOnboardingAccessRequest
  ): Promise<GetLatestOnboardingAccessResponse> {
    const process = await this.hrQueryService.getLatestOnboardingAccess({
      tenantId: getTrustedHrTenantId(request),
      employeeId: request.employeeId ?? ''
    })

    if (!process) {
      return {}
    }

    return {
      process: {
        id: process.id ?? '',
        tenantId: process.tenantId,
        employeeId: process.employeeId,
        employmentId: process.employmentId,
        accountId: process.accountId ?? '',
        status: mapOnboardingAccessStatus(process.status),
        grantIdempotencyKey: process.grantIdempotencyKey ?? '',
        failureReason: process.failureReason ?? ''
      }
    }
  }
}

/** mapProtoEmploymentStatus converts optional generated proto status filters into domain filters. */
function mapProtoEmploymentStatus(status?: ProtoEmploymentStatus): EmploymentStatus | undefined {
  switch (status) {
    case ProtoEmploymentStatus.EMPLOYMENT_STATUS_ACTIVE:
      return EmploymentStatus.ACTIVE
    case ProtoEmploymentStatus.EMPLOYMENT_STATUS_ENDED:
      return EmploymentStatus.ENDED
    default:
      return undefined
  }
}

/** mapProtoEmployeeLifecycleStatus converts optional generated proto lifecycle filters into domain filters. */
function mapProtoEmployeeLifecycleStatus(
  status?: ProtoEmployeeLifecycleStatus
): EmployeeLifecycleStatus | undefined {
  switch (status) {
    case ProtoEmployeeLifecycleStatus.EMPLOYEE_LIFECYCLE_STATUS_PREBOARDING:
      return EmployeeLifecycleStatus.PREBOARDING
    case ProtoEmployeeLifecycleStatus.EMPLOYEE_LIFECYCLE_STATUS_ACTIVE:
      return EmployeeLifecycleStatus.ACTIVE
    case ProtoEmployeeLifecycleStatus.EMPLOYEE_LIFECYCLE_STATUS_OFFBOARDED:
      return EmployeeLifecycleStatus.OFFBOARDED
    default:
      return undefined
  }
}

/** mapOnboardingAccessStatus converts HR onboarding compensation strings into the generated proto enum. */
function mapOnboardingAccessStatus(status?: string): ProtoOnboardingAccessStatus {
  switch (status) {
    case 'ACCOUNT_BINDING_PENDING':
      return ProtoOnboardingAccessStatus.ONBOARDING_ACCESS_STATUS_ACCOUNT_BINDING_PENDING
    case 'ACCESS_GRANT_PENDING':
      return ProtoOnboardingAccessStatus.ONBOARDING_ACCESS_STATUS_ACCESS_GRANT_PENDING
    case 'COMPLETED':
      return ProtoOnboardingAccessStatus.ONBOARDING_ACCESS_STATUS_COMPLETED
    default:
      return ProtoOnboardingAccessStatus.ONBOARDING_ACCESS_STATUS_UNSPECIFIED
  }
}

/** Derives HR tenant authority only from the locally verified ExecutionToken. */
function getTrustedHrTenantId(request: object): string {
  const tenantId =
    getAuthenticatedGrpcRequestContext(request)?.verifiedExecutionToken?.tenantId?.trim()
  if (!tenantId || tenantId === 'SYSTEM' || tenantId === '*')
    throw new Error('HR trusted tenant context is required')
  return tenantId
}

/** Applies HR's frozen BUSINESS Code declaration to each baseline handler. */
function applyHrDeclaration(method: string, code: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HrQueryGrpcController.prototype, method)
  if (!descriptor) throw new Error(`HR handler is missing: ${method}`)
  AuthorizeBusinessRpc({ all: [code] })(HrQueryGrpcController.prototype, method, descriptor)
}
applyHrDeclaration('getEmployeeById', 'hr.employee.get_by_id')
applyHrDeclaration('getEmployeeByTenantPartyId', 'hr.employee.get_by_id')
applyHrDeclaration('resolveActiveEmployeeByCode', 'hr.employee.get_by_id')
applyHrDeclaration('getActiveEmployment', 'hr.employee.get_by_id')
applyHrDeclaration('listEmployments', 'hr.employee.get_by_id')
applyHrDeclaration('getLatestOnboardingAccess', 'hr.employee.get_by_id')
applyHrDeclaration('listEmployees', 'hr.employee.list')
