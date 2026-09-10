import { parseRoleInstanceFoundationRollbackArgs } from '../scripts/role-instance-foundation-rollback'

describe('role instance foundation rollback CLI', () => {
  it('defaults to dry-run and sorts unique permission codes', () => {
    expect(
      parseRoleInstanceFoundationRollbackArgs([
        '--',
        '--permission-code=z.permission',
        '--permission-code',
        'a.permission',
        '--permission-code=z.permission'
      ])
    ).toEqual({
      apply: false,
      permissionCodes: ['a.permission', 'z.permission']
    })
  })

  it('requires explicit permission scope and rejects unknown arguments', () => {
    expect(() => parseRoleInstanceFoundationRollbackArgs(['--apply'])).toThrow(
      'At least one --permission-code is required'
    )
    expect(() =>
      parseRoleInstanceFoundationRollbackArgs([
        '--apply',
        '--permission-code',
        'collaboration.task.create',
        '--all'
      ])
    ).toThrow('Unsupported argument: --all')
  })
})
