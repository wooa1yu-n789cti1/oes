import {
  buildPermissionServiceSeed,
  renderPermissionServiceSeedDryRunSummary,
  validatePermissionServiceSeed
} from '../scripts/permission-service-seed'
import {
  COLLABORATION_TASK_PERMISSION_CODES,
  BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES,
  CRM_MANAGEMENT_PERMISSION_CODES,
  IDENTITY_ACCOUNT_PERMISSION_CODES,
  ITEM_MASTER_INTERNAL_PERMISSION_CODES,
  TERMINAL_DEVICE_MANAGEMENT_PERMISSION_CODES
} from '../scripts/permission-catalog'
import { Modules } from '../../prisma/generated/prisma'

const EXPECTED_TERMINAL_DEVICE_PERMISSION_CODES = [
  'terminal-device.enrollment.create',
  'terminal-device.enrollment.revoke',
  'terminal-device.read',
  'terminal-device.sensitive.read',
  'terminal-device.status.disable',
  'terminal-device.status.mark-lost',
  'terminal-device.status.mark-maintenance',
  'terminal-device.status.restore-active',
  'terminal-device.version-policy.manage',
  'terminal-device.audit.read',
  'terminal-device.update'
] as const

// Verifies the consolidated permission-service seed source is complete and DB-write free.
describe('permission service seed source', () => {
  it('publishes the consolidated foundation seed without validation errors', () => {
    const seed = buildPermissionServiceSeed()

    expect(validatePermissionServiceSeed(seed)).toEqual([])
    expect(seed.permissionCodes).toHaveLength(295)
    expect(Object.values(TERMINAL_DEVICE_MANAGEMENT_PERMISSION_CODES)).toEqual([
      ...EXPECTED_TERMINAL_DEVICE_PERMISSION_CODES
    ])
    expect(seed.permissionCodes.map((permission) => permission.code)).toEqual(
      expect.arrayContaining([...EXPECTED_TERMINAL_DEVICE_PERMISSION_CODES])
    )
    expect(seed.permissionCodes.map((permission) => permission.code)).toEqual(
      expect.arrayContaining([
        CRM_MANAGEMENT_PERMISSION_CODES.READ_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.CREATE_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.UPDATE_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.CONVERT_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.CLAIM_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.RELEASE_CRM_ACCOUNT,
        CRM_MANAGEMENT_PERMISSION_CODES.MANAGE_CRM_ACCOUNT,
        BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES.POLICY_READ,
        BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES.POLICY_MANAGE,
        BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES.OVERVIEW_READ,
        BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES.EMPLOYEE_DETAIL_READ,
        BROWSER_ACTIVITY_AUDIT_PERMISSION_CODES.URL_DETAIL_READ,
        COLLABORATION_TASK_PERMISSION_CODES.ASSIGN,
        ...Object.values(ITEM_MASTER_INTERNAL_PERMISSION_CODES)
      ])
    )
    expect(
      seed.permissionCodes.find(
        (permission) => permission.code === COLLABORATION_TASK_PERMISSION_CODES.ASSIGN
      )?.module
    ).toBe(Modules.COLLABORATION_SERVICE)
    expect(
      seed.permissionCodes
        .filter((permission) =>
          (EXPECTED_TERMINAL_DEVICE_PERMISSION_CODES as readonly string[]).includes(permission.code)
        )
        .map((permission) => permission.module)
    ).toEqual(EXPECTED_TERMINAL_DEVICE_PERMISSION_CODES.map(() => Modules.TERMINAL_DEVICE_SERVICE))
    expect(seed.deprecatedPermissionCodes).toEqual(
      expect.arrayContaining([
        'permission.role.create',
        'permission.role.update',
        'permission.role.delete_by_id',
        'permission.role.list',
        'permission.role.get_by_id',
        'permission.role_template.delete_by_id',
        'permission.role_template.permission.assign',
        'permission.role_template.permission.revoke',
        'permission.role_instance.delete_by_id',
        'permission.role_instance.permission.assign',
        'permission.role_instance.permission.revoke',
        'identity.org.membership.add',
        'identity.org.membership.remove',
        'identity.org.membership.set_primary'
      ])
    )
    expect(seed.deprecatedPermissionCodes).toHaveLength(31)
    expect(seed.roles.map((role) => role.code)).toEqual([
      'system.admin',
      'tenant.admin',
      'hr.admin',
      'account.basic',
      'mes.forming_workshop.supervisor',
      'item_master.product_data_manager',
      'extension.designer',
      'crm.sales',
      'crm.sales_manager'
    ])
    expect(seed.rolePermissions).toHaveLength(225)
    expect(seed.navigationEntries).toHaveLength(40)
    expect(seed.roleNavigationVisibility).toHaveLength(52)
    expect(seed.roleLandingPolicies).toHaveLength(9)
    expect(seed.roleTerminalAccess).toHaveLength(9)
    expect(seed.policyInstances).toHaveLength(0)
  })

  it('renders a stable dry-run summary for audit output', () => {
    expect(renderPermissionServiceSeedDryRunSummary(buildPermissionServiceSeed())).toEqual({
      permissionCodeCount: 295,
      deprecatedPermissionCodeCount: 31,
      roleCount: 9,
      rolePermissionCount: 225,
      navigationEntryCount: 40,
      deprecatedNavigationEntryCount: 2,
      roleNavigationVisibilityCount: 52,
      roleLandingPolicyCount: 9,
      roleTerminalAccessCount: 9,
      policyInstanceCount: 0
    })
  })

  it('keeps every landing policy inside the matching role visibility set', () => {
    const seed = buildPermissionServiceSeed()
    const visibleEntryKeys = new Set(
      seed.roleNavigationVisibility
        .filter((item) => item.enabled)
        .map((item) => `${item.roleId}:${item.terminal}:${item.entryKey}`)
    )

    for (const landingPolicy of seed.roleLandingPolicies) {
      expect(
        visibleEntryKeys.has(
          `${landingPolicy.roleId}:${landingPolicy.terminal}:${landingPolicy.defaultEntryKey}`
        )
      ).toBe(true)
    }
  })
})
