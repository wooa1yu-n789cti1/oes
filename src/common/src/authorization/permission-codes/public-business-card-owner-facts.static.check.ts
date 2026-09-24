import { describe, it, test } from 'node:test'
import { expect } from '../../testing/static-check-assertions.mjs'
import { fileURLToPath } from 'node:url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('Public Business Card owner-fact permission catalog and workload policy', () => {
    const ownerFactTuples = [
        ['urn:oes:service:hr-service', 'hr.internal.public_business_card_employee.resolve'],
        ['urn:oes:service:identity-service', 'identity.internal.public_business_card_identity.resolve'],
        [
            'urn:oes:service:tenant-org-service',
            'tenant_org.internal.public_business_card_organization.resolve'
        ]
    ] as const;
    const authenticatedRbacTuple = [
        'urn:oes:service:permission-service',
        'permission.internal.permission.check'
    ] as const;
    it('binds Public Entry only to its owner resolvers and authenticated RBAC check', () => {
        const policies = JSON.parse(readFileSync(join(__dirname, '../../../../../scripts/local/runtime-config/permission-workload-issuance-policies.json'), 'utf8'));
        const entries = policies.filter((entry: any) => entry.originalWorkloadSpiffeId.endsWith('/public-entry-service'));
        expect(entries).toHaveLength(4);
        expect(entries.map((entry: any) => [entry.targetAudience, entry.permissionCodes[0]]).sort()).toEqual([...ownerFactTuples, authenticatedRbacTuple].sort());
        for (const entry of entries) {
            expect(entry.scopeLevel).toBe('SYSTEM');
            expect(entry.permissionCodes).toHaveLength(1);
            expect(JSON.stringify(entry)).not.toContain('*');
            expect(entry).not.toHaveProperty('tenantIds');
            expect(entry).not.toHaveProperty('role');
            expect(entry).not.toHaveProperty('grant');
        }
    });
});
